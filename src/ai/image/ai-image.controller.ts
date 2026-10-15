import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type {Response} from 'express';
import * as multer from 'multer';
import {CurrentAccount} from '../../business/decorators/current-account.decorator';
import {JwtAuthGuard} from '../../business/jwt-auth.guard';
import {IAccount} from '../../business/types';
import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import {FeatureGuard} from '../../feature/feature.guard';
import {RequireFeature} from '../../feature/require-feature.decorator';
import {RequirePermission} from '../../permission/permission.decorator';
import {PermissionsGuard} from '../../permission/permissions.guard';
import {PlanTierGuard} from '../../subscription/plan-tier.guard';
import {MinTier} from '../../subscription/required-tier.decorator';
import {DescribeProductImageDto, GenerateProductImageDto} from './ai-image.dto';
import {
  AiImageService,
  MAX_SOURCE_BYTES,
  SourcePhoto,
} from './ai-image.service';

/** What a phone hands the browser; HEIC goes to Gemini as-is. */
const ALLOWED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

/** A 1024px WebP packshot is ~100–300 KB; this is a ceiling, not a target. */
const MAX_ATTACH_BYTES = 5 * 1024 * 1024;

/** In memory only: the photo is read in flight and never stored (AI-RASM.md). */
const photoUpload = FileInterceptor('photo', {
  storage: multer.memoryStorage(),
  limits: {fileSize: MAX_SOURCE_BYTES, files: 1},
});

/**
 * AI product packshots (AI-RASM.md) — Pimpo's own Gemini key, so every call
 * is our money against the shop's monthly allowance.
 *
 * Guard order as for every flagged feature: FeatureGuard before the tier so a
 * shop without the beta hears "not enabled", not "upgrade"; the permission
 * last. All three are enforced here, not just in the UI.
 */
@ApiTags('ai')
@Controller('ai/product-image')
@UseGuards(JwtAuthGuard, FeatureGuard, PlanTierGuard, PermissionsGuard)
@RequireFeature('ai_product_image')
@MinTier('pro')
@RequirePermission('product:image:generate')
@ApiBearerAuth('JWT-auth')
export class AiImageController {
  constructor(private readonly images: AiImageService) {}

  @Get('usage')
  @ApiOperation({
    summary: "This month's AI image allowance, as % and ≈ images left",
  })
  usage(@CurrentAccount() account: IAccount) {
    return this.images.usage(account.businessId);
  }

  @Post('describe')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(photoUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Draft the English packaging description (step 1)',
    description:
      'From the name (+ brand, category, unit) and, when given, a photo. ' +
      'The shop edits the result before generating.',
  })
  async describe(
    @CurrentAccount() account: IAccount,
    @Body() dto: DescribeProductImageDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const source = await this.source(file, dto.sourceImageUrl);
    return this.images.describe(
      account,
      {
        name: dto.name,
        brand: dto.brand,
        category: dto.category,
        unit: dto.unit,
      },
      source,
    );
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(photoUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Make the packshot (step 2)',
    description:
      'With a photo (file or our own image URL): the real pack on white. ' +
      'Without: drawn from the description alone. The body is the picture ' +
      'itself (image/webp), not JSON — the id, mode and allowance travel in ' +
      'X-Ai-Image-* headers. It is stored only by /:id/attach.',
  })
  async generate(
    @CurrentAccount() account: IAccount,
    @Body() dto: GenerateProductImageDto,
    @Res({passthrough: true}) res: Response,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<StreamableFile> {
    const source = await this.source(file, dto.sourceImageUrl);
    const result = await this.images.generate(
      account,
      {description: dto.description, productId: dto.productId},
      source,
    );
    res.setHeader('X-Ai-Image-Id', result.id);
    res.setHeader('X-Ai-Image-Mode', result.mode);
    res.setHeader('X-Ai-Image-Usage', JSON.stringify(result.usage));
    // The dashboard is another origin: without this the browser hides the
    // custom headers from fetch().
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-Ai-Image-Id, X-Ai-Image-Mode, X-Ai-Image-Usage',
    );
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(result.image, {
      type: 'image/webp',
      length: result.image.length,
    });
  }

  @Post(':id/attach')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: multer.memoryStorage(),
      limits: {fileSize: MAX_ATTACH_BYTES, files: 1},
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Store an accepted packshot (step 3)',
    description:
      'Called while the product it was accepted for is being saved, with the ' +
      'WebP /generate returned (`image` part): it goes to S3 and the URL comes ' +
      'back for the product. A packshot nobody attaches is never stored.',
  })
  attach(
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new AppException(ErrorCode.NO_FILE_PROVIDED);
    }
    return this.images.attach(account, id, file.buffer);
  }

  /** An uploaded photo wins over a URL; neither = text mode. */
  private async source(
    file: Express.Multer.File | undefined,
    sourceImageUrl: string | undefined,
  ): Promise<SourcePhoto | null> {
    if (file?.buffer?.length) {
      if (!ALLOWED_MIMES.includes(file.mimetype)) {
        throw new AppException(ErrorCode.INVALID_FILE_TYPE, {
          allowed: ALLOWED_MIMES.join(', '),
        });
      }
      return {data: file.buffer, mimeType: file.mimetype};
    }
    if (sourceImageUrl) return this.images.sourceFromOwnUrl(sourceImageUrl);
    return null;
  }
}

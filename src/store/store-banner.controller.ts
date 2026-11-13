import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import * as multer from 'multer';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {IBusiness} from '../business/types';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {RequirePermission} from '../permission/permission.decorator';
import {PermissionsGuard} from '../permission/permissions.guard';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {
  ReorderStoreBannersDto,
  SaveStoreBannerDto,
} from './dto/store-banner.dto';
import {StoreBannerService} from './store-banner.service';
import {StoreService} from './store.service';

const MAX_BANNER_BYTES = 10 * 1024 * 1024;

/** The storefront's read of its banners — public, scoped by the store slug. */
@ApiTags('store')
@Controller('store/banners')
export class StoreBannerPublicController {
  constructor(
    private readonly store: StoreService,
    private readonly banners: StoreBannerService,
  ) {}

  @Get()
  @ApiOperation({summary: 'Banners the storefront shows today (public)'})
  @ApiQuery({name: 'store', required: false, type: String})
  async list(@Query('store') store?: string) {
    const businessId = await this.store.resolveBusinessId(store);
    return this.banners.listPublic(businessId);
  }
}

/**
 * Settings → Online store → Banners. The online store is a Business-plan
 * feature, so its banners are too.
 */
@ApiTags('store')
@Controller('businesses/me/store/banners')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('pro')
@RequirePermission('settings:manage')
@ApiBearerAuth('JWT-auth')
export class StoreBannerSettingsController {
  constructor(private readonly banners: StoreBannerService) {}

  @Get()
  @ApiOperation({summary: "The shop's banners, in order, with today's status"})
  list(@CurrentBusiness() business: IBusiness) {
    return this.banners.list(business.id);
  }

  @Post('image')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: multer.memoryStorage(),
      limits: {fileSize: MAX_BANNER_BYTES},
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({summary: 'Upload a banner picture (cropped to 2:1, WebP)'})
  uploadImage(
    @CurrentBusiness() business: IBusiness,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file?.buffer) throw new AppException(ErrorCode.NO_FILE_PROVIDED);
    return this.banners.uploadImage(business.id, file);
  }

  @Post()
  @ApiOperation({summary: 'Add a banner'})
  create(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: SaveStoreBannerDto,
  ) {
    return this.banners.create(business.id, dto);
  }

  @Put('order')
  @ApiOperation({summary: 'Set the order the banners show in'})
  reorder(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: ReorderStoreBannersDto,
  ) {
    return this.banners.reorder(business.id, dto.ids);
  }

  @Put(':id')
  @ApiOperation({summary: 'Change a banner (partial)'})
  @ApiParam({name: 'id'})
  update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: SaveStoreBannerDto,
  ) {
    return this.banners.update(business.id, id, dto);
  }

  @Delete(':id')
  @ApiOperation({summary: 'Remove a banner'})
  @ApiParam({name: 'id'})
  remove(@CurrentBusiness() business: IBusiness, @Param('id') id: string) {
    return this.banners.remove(business.id, id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiTags} from '@nestjs/swagger';
import * as multer from 'multer';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {PlatformJwtGuard} from '../platform/platform-jwt.guard';
import {SaveGlobalCategoryDto, SaveStoreDirectionDto} from './dto/category-preset.dto';
import {GlobalCatalogService} from './global-catalog.service';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Platform console → Kategoriyalar: the shared category list and the lines of
 * trade (AI-SOZLASH.md §3). Nothing is ever deleted — `isHidden` stops
 * offering a row to new shops while the shops that use it keep it.
 */
@ApiTags('platform')
@Controller('platform/catalog')
@UseGuards(PlatformJwtGuard)
@ApiBearerAuth('JWT-auth')
export class GlobalCatalogPlatformController {
  constructor(private readonly catalog: GlobalCatalogService) {}

  @Get()
  @ApiOperation({summary: 'Every global category and line of trade, hidden ones too'})
  list() {
    return this.catalog.listForPlatform();
  }

  @Post('categories')
  @ApiOperation({summary: 'Add a global category'})
  createCategory(@Body() dto: SaveGlobalCategoryDto) {
    return this.catalog.createCategory(dto);
  }

  @Put('categories/:key')
  @ApiOperation({summary: 'Change a global category (names, hidden, order)'})
  @ApiParam({name: 'key'})
  updateCategory(@Param('key') key: string, @Body() dto: SaveGlobalCategoryDto) {
    return this.catalog.updateCategory(key, dto);
  }

  @Put('categories/:key/image')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: multer.memoryStorage(),
      limits: {fileSize: MAX_IMAGE_BYTES},
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({summary: "Replace a global category's picture"})
  @ApiParam({name: 'key'})
  setImage(@Param('key') key: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer) throw new AppException(ErrorCode.NO_FILE_PROVIDED);
    return this.catalog.setCategoryImage(key, file);
  }

  @Delete('categories/:key/image')
  @ApiOperation({summary: "Remove a global category's picture"})
  @ApiParam({name: 'key'})
  removeImage(@Param('key') key: string) {
    return this.catalog.removeCategoryImage(key);
  }

  @Post('directions')
  @ApiOperation({summary: 'Add a line of trade'})
  createDirection(@Body() dto: SaveStoreDirectionDto) {
    return this.catalog.createDirection(dto);
  }

  @Put('directions/:key')
  @ApiOperation({summary: 'Change a line of trade (names, categories, hidden, order)'})
  @ApiParam({name: 'key'})
  updateDirection(@Param('key') key: string, @Body() dto: SaveStoreDirectionDto) {
    return this.catalog.updateDirection(key, dto);
  }
}

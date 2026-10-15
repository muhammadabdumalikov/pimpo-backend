import {
  Controller,
  Delete,
  Get,
  Param,
  Put,
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
  ApiTags,
} from '@nestjs/swagger';
import * as multer from 'multer';
import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import {PlatformJwtGuard} from '../../platform/platform-jwt.guard';
import {GlobalBarcodeService} from './global-barcode.service';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Platform console: the shared barcode catalogue's picture. Looked up by
 * barcode; replacing it moves every shop card that shows it.
 */
@ApiTags('platform')
@Controller('platform/global-barcodes')
@UseGuards(PlatformJwtGuard)
@ApiBearerAuth('JWT-auth')
export class GlobalBarcodePlatformController {
  constructor(private readonly globalBarcodes: GlobalBarcodeService) {}

  @Get(':barcode')
  @ApiOperation({summary: 'A shared catalogue entry and how shops use it'})
  @ApiParam({name: 'barcode'})
  get(@Param('barcode') barcode: string) {
    return this.globalBarcodes.get(barcode);
  }

  @Put(':barcode/image')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: multer.memoryStorage(),
      limits: {fileSize: MAX_IMAGE_BYTES},
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({summary: "Replace a barcode's shared picture"})
  @ApiParam({name: 'barcode'})
  setImage(
    @Param('barcode') barcode: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file?.buffer) throw new AppException(ErrorCode.NO_FILE_PROVIDED);
    return this.globalBarcodes.setImage(barcode, file);
  }

  @Delete(':barcode/image')
  @ApiOperation({summary: "Remove a barcode's shared picture"})
  @ApiParam({name: 'barcode'})
  removeImage(@Param('barcode') barcode: string) {
    return this.globalBarcodes.removeImage(barcode);
  }
}

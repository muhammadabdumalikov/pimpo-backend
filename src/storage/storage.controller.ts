import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  UseGuards,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import * as multer from 'multer';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { StorageService } from './storage.service';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

@ApiTags('storage')
@Controller('storage')
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(private readonly storage: StorageService) { }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  @ApiOperation({ summary: 'Upload a file to S3' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        prefix: { type: 'string', description: 'Folder prefix, e.g. products, categories' },
      },
    },
  })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('prefix') prefix?: string,
  ): Promise<{ url: string; key: string }> {
    if (!this.storage.isEnabled()) {
      throw new BadRequestException('File storage is not configured.');
    }
    if (!file?.buffer) {
      throw new BadRequestException('No file provided.');
    }
    const contentType = file.mimetype || 'application/octet-stream';
    if (!ALLOWED_MIMES.includes(contentType)) {
      throw new BadRequestException(
        `Invalid file type. Allowed: ${ALLOWED_MIMES.join(', ')}`,
      );
    }

    return this.storage.upload(file.buffer, {
      contentType,
      prefix: prefix || 'uploads',
    });
  }
}

import {
  Body,
  Controller,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {FilesInterceptor} from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import * as multer from 'multer';
import {CurrentBusiness} from '../../business/decorators/current-business.decorator';
import {JwtAuthGuard} from '../../business/jwt-auth.guard';
import {IBusiness} from '../../business/types';
import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import {MinTier} from '../../subscription/required-tier.decorator';
import {PlanTierGuard} from '../../subscription/plan-tier.guard';
import {isValidModelId} from '../providers/llm-provider.interface';
import {InvoiceService, ParsedInvoice} from './invoice.service';

/**
 * A phone photo of a delivery note is routinely 3-8 MB. Above this the useful
 * detail is gone anyway — the providers downscale large images before reading
 * them — and holding it in memory on a 2 vCPU host is the real cost.
 */
const MAX_FILE_SIZE = 15 * 1024 * 1024;

/**
 * Pages accepted in one scan.
 *
 * A delivery note routinely runs to two or three sheets, and a long one gets
 * photographed in halves because the print is unreadable otherwise. Every page
 * is re-sent as image tokens on the same call, so this is a cost ceiling as
 * much as a sanity one.
 */
const MAX_PAGES = 6;

/** What every provider in the picker can actually read. */
const ALLOWED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

/**
 * Reading a supplier delivery note into receipt lines.
 *
 * Pro tier, like the rest of the AI surface: it runs on the same BYOK key, and
 * a plan with no key configured has nothing to run it with.
 *
 * Not owner-only — receiving goods is a manager's job, and this endpoint never
 * exposes the key, only spends it.
 */
@ApiTags('ai')
@Controller('ai/invoice')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('pro')
@ApiBearerAuth('JWT-auth')
export class InvoiceController {
  constructor(private readonly invoices: InvoiceService) {}

  @Post('parse')
  @UseInterceptors(
    FilesInterceptor('files', MAX_PAGES, {
      // In memory, never on disk and never in S3: the pages are read in flight
      // and the bytes are dropped when the request ends.
      storage: multer.memoryStorage(),
      limits: {fileSize: MAX_FILE_SIZE, files: MAX_PAGES},
    }),
  )
  @ApiOperation({
    summary: 'Nakladnoy rasmidan mahsulot qatorlarini o‘qish',
    description:
      'Reads a photographed or scanned delivery note and returns its rows ' +
      'matched against the shop catalogue. Nothing is written: the caller ' +
      'confirms the rows and posts them as a normal goods receipt.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: {type: 'string', format: 'binary'},
          description: `Pages of ONE delivery note, in order (max ${MAX_PAGES}).`,
        },
        model: {
          type: 'string',
          description:
            'Per-request model override; falls back to the saved default.',
        },
        continuation: {
          type: 'boolean',
          description:
            'These pages continue a note already being reviewed, so they carry ' +
            'no column headers of their own. Returns rows only.',
        },
      },
    },
  })
  async parse(
    @CurrentBusiness() business: IBusiness,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('model') model?: string,
    @Body('continuation') continuation?: string,
  ): Promise<ParsedInvoice> {
    const pages = (files ?? []).filter((f) => f?.buffer?.length);
    if (!pages.length) {
      throw new AppException(ErrorCode.NO_FILE_PROVIDED);
    }
    const bad = pages.find((f) => !ALLOWED_MIMES.includes(f.mimetype));
    if (bad) {
      throw new AppException(ErrorCode.INVALID_FILE_TYPE, {
        allowed: ALLOWED_MIMES.join(', '),
      });
    }

    // A malformed override is dropped rather than rejected: the saved default
    // is always a working model, so the scan succeeds instead of 400-ing on a
    // field the owner never typed.
    const override = model && isValidModelId(model) ? model : undefined;

    return this.invoices.parse(business.id, pages, {
      model: override,
      // Multipart carries no booleans — everything arrives as text.
      continuation: continuation === 'true',
    });
  }
}

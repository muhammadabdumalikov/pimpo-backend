import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {ApiTags, ApiOperation, ApiBearerAuth} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {BillzService} from './billz.service';
import {BillzImportService} from './billz-import.service';
import {VerifyBillzDto} from './dto/verify-billz.dto';
import {StartImportDto} from './dto/start-import.dto';
import {ImportItemsQueryDto} from './dto/import-items-query.dto';
import {ProbeBillzDto} from './dto/probe-billz.dto';
import type {ItemDto, JobDto, ProbeResponse} from './billz-import.types';

@ApiTags('billz')
@Controller('billz')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class BillzController {
  constructor(
    private readonly billz: BillzService,
    private readonly billzImport: BillzImportService,
  ) {}

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Verify a BiLLZ secret key and connect the current business for migration',
  })
  async verify(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: VerifyBillzDto,
  ): Promise<{ok: true; expiresIn: number}> {
    // On an invalid key BillzService throws BILLZ_TOKEN_INVALID (400); on
    // BiLLZ being unreachable it throws BILLZ_UNAVAILABLE (502) — both propagate
    // to the global exception filter as coded errors the frontend localizes.
    const {expiresIn} = await this.billz.verify(business.id, dto.secretToken);
    return {ok: true, expiresIn};
  }

  @Get('status')
  @ApiOperation({
    summary: 'BiLLZ connection status for the current business',
  })
  async status(
    @CurrentBusiness() business: IBusiness,
  ): Promise<{connected: boolean; verifiedAt: string | null}> {
    return this.billz.getStatus(business.id);
  }

  @Get('probe')
  @ApiOperation({
    summary:
      'MG2: preview one page of raw BiLLZ JSON + how KPOS maps each field (read-only)',
  })
  async probe(
    @CurrentBusiness() business: IBusiness,
    @Query() query: ProbeBillzDto,
  ): Promise<ProbeResponse> {
    // BILLZ_NOT_CONNECTED (400) if unverified; BILLZ_UNAVAILABLE (502) if BiLLZ
    // is unreachable — both propagate as coded errors the frontend localizes.
    return this.billz.probe(business.id, query.entity);
  }

  // ── Import job queue (MG3/MG4/MG5) ─────────────────────────────────────────

  @Post('import/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Queue a BiLLZ import for the chosen entities'})
  async startImport(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: StartImportDto,
  ): Promise<{job: JobDto}> {
    // BILLZ_NOT_CONNECTED (400) if no verified connection; ALREADY_ACTIVE (409)
    // if a job is already queued/running/paused — both propagate as coded errors.
    return this.billzImport.start(business.id, dto.entities);
  }

  @Get('import/status')
  @ApiOperation({
    summary: 'Latest import job for the business + its FIFO queue position',
  })
  async importStatus(@CurrentBusiness() business: IBusiness): Promise<{
    job: JobDto | null;
    queuePosition: number | null;
    queueLength: number;
  }> {
    return this.billzImport.getStatus(business.id);
  }

  @Post('import/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Pause the active import (queued/running → paused)'})
  async pauseImport(
    @CurrentBusiness() business: IBusiness,
  ): Promise<{job: JobDto}> {
    return this.billzImport.pause(business.id);
  }

  @Post('import/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Resume a paused import (paused → queued)'})
  async resumeImport(
    @CurrentBusiness() business: IBusiness,
  ): Promise<{job: JobDto}> {
    return this.billzImport.resume(business.id);
  }

  @Post('import/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Cancel the active import (queued/running/paused)'})
  async cancelImport(
    @CurrentBusiness() business: IBusiness,
  ): Promise<{job: JobDto}> {
    return this.billzImport.cancel(business.id);
  }

  @Get('import/items')
  @ApiOperation({
    summary: 'Browse the per-record import log (cumulative across jobs)',
  })
  async importItems(
    @CurrentBusiness() business: IBusiness,
    @Query() query: ImportItemsQueryDto,
  ): Promise<{items: ItemDto[]; total: number; page: number; limit: number}> {
    return this.billzImport.getItems(business.id, query);
  }
}

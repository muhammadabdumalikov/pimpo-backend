import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {ymdOrUndefined} from '../../common/business-time';
import {PlatformJwtGuard} from '../../platform/platform-jwt.guard';
import {
  AiImageJobIdsDto,
  AiImageProductIdsDto,
  SetAiImageQuotaDto,
} from './ai-image.dto';
import {AiImageJobsService} from './ai-image-jobs.service';
import {AiImageService} from './ai-image.service';

/**
 * Platform console for AI product images: spend over any date range, this
 * month's against the platform budget, and each shop's allowance (Q9 — raise it for a shop filling
 * its catalogue, permanently or for this month only).
 */
@ApiTags('platform')
@Controller('platform')
@UseGuards(PlatformJwtGuard)
@ApiBearerAuth('JWT-auth')
export class AiImagePlatformController {
  constructor(
    private readonly images: AiImageService,
    private readonly jobs: AiImageJobsService,
  ) {}

  @Get('ai-images/summary')
  @ApiOperation({
    summary: 'AI image spend in a date range, monthly budget, top shops',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'First day (YYYY-MM-DD); none = no lower bound',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'Last day (YYYY-MM-DD); none = no upper bound',
  })
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.images.platformSummary(
      ymdOrUndefined(from),
      ymdOrUndefined(to),
    );
  }

  @Get('businesses/:id/ai-images/spend')
  @ApiOperation({summary: "A shop's AI image spend in a date range"})
  @ApiParam({name: 'id', description: 'Business ID'})
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'First day (YYYY-MM-DD); none = no lower bound',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'Last day (YYYY-MM-DD); none = no upper bound',
  })
  spend(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.images.businessSpend(
      id,
      ymdOrUndefined(from),
      ymdOrUndefined(to),
    );
  }

  @Get('businesses/:id/ai-image-quota')
  @ApiOperation({summary: "A shop's AI image allowance and this month's use"})
  @ApiParam({name: 'id', description: 'Business ID'})
  getQuota(@Param('id') id: string) {
    return this.images.getQuota(id);
  }

  @Put('businesses/:id/ai-image-quota')
  @ApiOperation({
    summary: "Set a shop's AI image allowance / this month's bonus",
  })
  @ApiParam({name: 'id', description: 'Business ID'})
  setQuota(@Param('id') id: string, @Body() dto: SetAiImageQuotaDto) {
    return this.images.setQuota(id, dto);
  }

  // ── Pictures for a shop's best sellers, paid by the platform ─────────────

  @Get('businesses/:id/ai-images/candidates')
  @ApiOperation({
    summary:
      "A shop's best sellers without a picture, and the console jobs for them",
  })
  @ApiParam({name: 'id', description: 'Business ID'})
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Sales window (default 90)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'How many (default 50, max 200)',
  })
  candidates(
    @Param('id') id: string,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobs.candidates(
      id,
      clampInt(days, 90, 1, 730),
      clampInt(limit, 50, 1, 200),
    );
  }

  @Post('businesses/:id/ai-images/jobs')
  @ApiOperation({
    summary: 'Queue AI pictures for these products (platform budget)',
  })
  @ApiParam({name: 'id', description: 'Business ID'})
  enqueue(@Param('id') id: string, @Body() dto: AiImageProductIdsDto) {
    return this.jobs.enqueue(id, dto.productIds);
  }

  @Post('businesses/:id/ai-images/apply-global')
  @ApiOperation({
    summary: "Put the shared catalogue's picture on these cards (free)",
  })
  @ApiParam({name: 'id', description: 'Business ID'})
  applyGlobal(@Param('id') id: string, @Body() dto: AiImageProductIdsDto) {
    return this.jobs.applyGlobal(id, dto.productIds);
  }

  @Post('businesses/:id/ai-images/jobs/approve')
  @ApiOperation({summary: 'Put these ready pictures on their cards'})
  @ApiParam({name: 'id', description: 'Business ID'})
  approve(@Param('id') id: string, @Body() dto: AiImageJobIdsDto) {
    return this.jobs.approve(id, dto.jobIds);
  }

  @Post('businesses/:id/ai-images/jobs/reject')
  @ApiOperation({summary: 'Reject these ready pictures'})
  @ApiParam({name: 'id', description: 'Business ID'})
  reject(@Param('id') id: string, @Body() dto: AiImageJobIdsDto) {
    return this.jobs.reject(id, dto.jobIds);
  }

  @Post('businesses/:id/ai-images/jobs/retry')
  @ApiOperation({summary: 'Make a fresh picture for these jobs'})
  @ApiParam({name: 'id', description: 'Business ID'})
  retry(@Param('id') id: string, @Body() dto: AiImageJobIdsDto) {
    return this.jobs.retry(id, dto.jobIds);
  }

  @Post('businesses/:id/ai-images/jobs/cancel')
  @ApiOperation({summary: 'Drop the pictures not started yet'})
  @ApiParam({name: 'id', description: 'Business ID'})
  cancel(@Param('id') id: string) {
    return this.jobs.cancelQueued(id);
  }
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

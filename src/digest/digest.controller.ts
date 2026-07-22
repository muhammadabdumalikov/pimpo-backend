import {Controller, Get, Query, UseGuards} from '@nestjs/common';
import {ApiTags, ApiOperation, ApiBearerAuth, ApiQuery} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {DigestService} from './digest.service';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';

// Daily digest preview is an extended-analytics feature — Business (pro) and up.
@ApiTags('digest')
@Controller('digest')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('pro')
@ApiBearerAuth('JWT-auth')
export class DigestController {
  constructor(private readonly digestService: DigestService) {}

  @Get()
  @ApiOperation({summary: 'Kunlik digest (preview) — digest ma\'lumoti + Telegram matni'})
  @ApiQuery({name: 'date', required: false, description: 'YYYY-MM-DD (default: bugun)'})
  async getDigest(
    @CurrentBusiness() business: IBusiness,
    @Query('date') date?: string,
  ) {
    const digest = await this.digestService.buildDigest(business.id, date);
    return {
      digest,
      message: this.digestService.formatMessage(digest, business.name),
    };
  }
}

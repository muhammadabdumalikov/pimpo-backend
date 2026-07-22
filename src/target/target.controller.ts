import {Body, Controller, Get, Put, Query, UseGuards} from '@nestjs/common';
import {ApiTags, ApiOperation, ApiBearerAuth, ApiQuery} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {TargetService} from './target.service';
import {SetTargetDto} from './dto/set-target.dto';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';

// Monthly targets are an extended-analytics feature — Business (pro) and up.
@ApiTags('targets')
@Controller('targets')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('pro')
@ApiBearerAuth('JWT-auth')
export class TargetController {
  constructor(private readonly targetService: TargetService) {}

  @Get()
  @ApiOperation({summary: 'Oylik reja vs fakt (progress)'})
  @ApiQuery({name: 'month', required: false, description: 'YYYY-MM (default: joriy oy)'})
  async getProgress(
    @CurrentBusiness() business: IBusiness,
    @Query('month') month?: string,
  ) {
    return this.targetService.getProgress(business.id, month);
  }

  @Put()
  @ApiOperation({summary: 'Oylik rejani belgilash (upsert)'})
  async setTarget(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: SetTargetDto,
  ) {
    return this.targetService.setTarget(
      business.id,
      dto.month ?? '',
      dto.revenueTarget,
    );
  }
}

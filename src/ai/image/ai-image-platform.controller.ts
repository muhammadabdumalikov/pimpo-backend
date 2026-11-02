import {Body, Controller, Get, Param, Put, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags} from '@nestjs/swagger';
import {ymdOrUndefined} from '../../common/business-time';
import {PlatformJwtGuard} from '../../platform/platform-jwt.guard';
import {SetAiImageQuotaDto} from './ai-image.dto';
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
  constructor(private readonly images: AiImageService) {}

  @Get('ai-images/summary')
  @ApiOperation({summary: 'AI image spend in a date range, monthly budget, top shops'})
  @ApiQuery({name: 'from', required: false, description: 'First day (YYYY-MM-DD); none = no lower bound'})
  @ApiQuery({name: 'to', required: false, description: 'Last day (YYYY-MM-DD); none = no upper bound'})
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.images.platformSummary(ymdOrUndefined(from), ymdOrUndefined(to));
  }

  @Get('businesses/:id/ai-images/spend')
  @ApiOperation({summary: "A shop's AI image spend in a date range"})
  @ApiParam({name: 'id', description: 'Business ID'})
  @ApiQuery({name: 'from', required: false, description: 'First day (YYYY-MM-DD); none = no lower bound'})
  @ApiQuery({name: 'to', required: false, description: 'Last day (YYYY-MM-DD); none = no upper bound'})
  spend(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.images.businessSpend(id, ymdOrUndefined(from), ymdOrUndefined(to));
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
}

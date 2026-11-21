import {Controller, Get, Param, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags} from '@nestjs/swagger';
import {ymdOrUndefined} from '../common/business-time';
import {PlatformJwtGuard} from '../platform/platform-jwt.guard';
import {AssistantSpendService} from './assistant-spend.service';

/** Platform console: the customer AI bot's cost and margin over a date range. */
@ApiTags('platform')
@Controller('platform')
@UseGuards(PlatformJwtGuard)
@ApiBearerAuth('JWT-auth')
export class AssistantPlatformController {
  constructor(private readonly spend: AssistantSpendService) {}

  @Get('ai-assistant/summary')
  @ApiOperation({summary: 'Customer AI bot: answers, charged, cost and margin in a date range, top shops'})
  @ApiQuery({name: 'from', required: false, description: 'First day (YYYY-MM-DD); none = no lower bound'})
  @ApiQuery({name: 'to', required: false, description: 'Last day (YYYY-MM-DD); none = no upper bound'})
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.spend.platformSummary(ymdOrUndefined(from), ymdOrUndefined(to));
  }

  @Get('businesses/:id/ai-assistant/spend')
  @ApiOperation({summary: "A shop's customer AI bot answers, charged, cost and margin in a date range"})
  @ApiParam({name: 'id', description: 'Business ID'})
  @ApiQuery({name: 'from', required: false, description: 'First day (YYYY-MM-DD); none = no lower bound'})
  @ApiQuery({name: 'to', required: false, description: 'Last day (YYYY-MM-DD); none = no upper bound'})
  businessSpend(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.spend.businessSpend(id, ymdOrUndefined(from), ymdOrUndefined(to));
  }
}

import {Controller, Get, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiQuery, ApiTags} from '@nestjs/swagger';
import {ymdOrUndefined} from '../../common/business-time';
import {PlatformJwtGuard} from '../../platform/platform-jwt.guard';
import {InvoiceService} from './invoice.service';

/** Platform console: what the delivery-note scanner cost over a date range. */
@ApiTags('platform')
@Controller('platform')
@UseGuards(PlatformJwtGuard)
@ApiBearerAuth('JWT-auth')
export class InvoicePlatformController {
  constructor(private readonly invoices: InvoiceService) {}

  @Get('ai-invoices/summary')
  @ApiOperation({summary: 'Delivery-note scanner spend in a date range, top shops'})
  @ApiQuery({name: 'from', required: false, description: 'First day (YYYY-MM-DD); none = no lower bound'})
  @ApiQuery({name: 'to', required: false, description: 'Last day (YYYY-MM-DD); none = no upper bound'})
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.invoices.platformSummary(ymdOrUndefined(from), ymdOrUndefined(to));
  }
}

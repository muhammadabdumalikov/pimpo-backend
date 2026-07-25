import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { LoyaltyService } from './loyalty.service';
import { UpdateLoyaltySettingsDto } from './dto/update-loyalty-settings.dto';

@ApiTags('loyalty')
@Controller('loyalty')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Get('settings')
  @ApiOperation({ summary: 'Get loyalty program settings for the current business' })
  async getSettings(@CurrentBusiness() business: IBusiness) {
    return this.loyaltyService.getSettings(business.id);
  }

  @Put('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update loyalty program settings for the current business' })
  async updateSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateLoyaltySettingsDto,
  ) {
    return this.loyaltyService.updateSettings(business.id, dto);
  }

  @Get('customers')
  @ApiOperation({ summary: 'Customers with their loyalty balance, tier and last visit' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  async listCustomers(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.loyaltyService.listCustomers(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
    });
  }

  @Get('customers/:id/history')
  @ApiOperation({ summary: "One customer's loyalty ledger (earn/redeem history)" })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getCustomerHistory(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.loyaltyService.getCustomerHistory(business.id, id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}

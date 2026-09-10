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
import { PlanTierGuard } from '../subscription/plan-tier.guard';
import { MinTier } from '../subscription/required-tier.decorator';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { LoyaltyService } from './loyalty.service';
import { UpdateLoyaltySettingsDto } from './dto/update-loyalty-settings.dto';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';

// Loyalty (keshbek/bonus) is a Business-plan feature: it is one of the paid
// differentiators the tiers are priced on, so it sits behind `pro` rather than
// shipping on every plan. Earning/redeeming during checkout stays available to
// whoever already has balances — only configuring and reading the programme is
// gated here.
@ApiTags('loyalty')
@Controller('loyalty')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('pro')
@ApiBearerAuth('JWT-auth')
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Get('settings')
  @RequirePermission('customer:read')
  @ApiOperation({ summary: 'Get loyalty program settings for the current business' })
  async getSettings(@CurrentBusiness() business: IBusiness) {
    return this.loyaltyService.getSettings(business.id);
  }

  @Put('settings')
  @RequirePermission('loyalty:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update loyalty program settings for the current business' })
  async updateSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateLoyaltySettingsDto,
  ) {
    return this.loyaltyService.updateSettings(business.id, dto);
  }

  @Get('customers')
  @RequirePermission('customer:read')
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
  @RequirePermission('customer:read')
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

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PlatformService } from './platform.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformJwtGuard } from './platform-jwt.guard';
import { PlatformLoginDto } from './dto/platform-login.dto';
import { SetSubscriptionDto } from './dto/set-subscription.dto';
import { CreatePlatformBusinessDto } from './dto/create-platform-business.dto';
import { UpdateBusinessDto } from '../business/dto/update-business.dto';
import { TopUpBalanceDto, CreateDiscountDto } from '../subscription/dto/billing.dto';

/**
 * Platform-admin (super-admin) console: manage every tenant business, its
 * subscription and billing. Auth is a static login (PlatformAuthService) that
 * hands back a JWT; every data endpoint is then gated by PlatformJwtGuard. This
 * is deliberately separate from the tenant-facing JWT (`/businesses`,
 * `/subscriptions/current`).
 */
@ApiTags('platform')
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platformService: PlatformService,
    private readonly platformAuthService: PlatformAuthService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Static platform-admin login → returns a JWT' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  login(@Body() dto: PlatformLoginDto) {
    return this.platformAuthService.login(dto.login, dto.password);
  }

  @Get('stats')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Platform overview stats' })
  getStats() {
    return this.platformService.getStats();
  }

  @Get('businesses')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List all businesses with aggregate figures' })
  @ApiQuery({ name: 'search', required: false, description: 'Filter by name / login / email' })
  listBusinesses(@Query('search') search?: string) {
    return this.platformService.listBusinesses(search);
  }

  @Get('businesses/:id')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Full detail for one business' })
  @ApiParam({ name: 'id', description: 'Business ID' })
  getBusiness(@Param('id') id: string) {
    return this.platformService.getBusinessDetail(id);
  }

  @Post('businesses')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new business (email optional)' })
  @ApiResponse({ status: 409, description: 'Email or login already exists' })
  createBusiness(@Body() dto: CreatePlatformBusinessDto) {
    return this.platformService.createBusiness(dto);
  }

  @Put('businesses/:id')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a business (profile / active flag / password)' })
  @ApiParam({ name: 'id', description: 'Business ID' })
  updateBusiness(@Param('id') id: string, @Body() dto: UpdateBusinessDto) {
    return this.platformService.updateBusiness(id, dto);
  }

  @Delete('businesses/:id')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Permanently delete a business and all its data' })
  @ApiParam({ name: 'id', description: 'Business ID' })
  async deleteBusiness(@Param('id') id: string) {
    await this.platformService.deleteBusiness(id);
  }

  @Put('businesses/:id/subscription')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Set a business's subscription tier and optional expiry" })
  @ApiParam({ name: 'id', description: 'Business ID' })
  setSubscription(@Param('id') id: string, @Body() dto: SetSubscriptionDto) {
    return this.platformService.setSubscription(id, dto.tier, dto.endDate);
  }

  @Post('businesses/:id/topup')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Credit a business's prepaid balance" })
  @ApiParam({ name: 'id', description: 'Business ID' })
  topUp(@Param('id') id: string, @Body() dto: TopUpBalanceDto) {
    return this.platformService.topUpBalance(id, dto.amount);
  }

  @Post('businesses/:id/discounts')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Grant a promo discount to a business' })
  @ApiParam({ name: 'id', description: 'Business ID' })
  addDiscount(@Param('id') id: string, @Body() dto: CreateDiscountDto) {
    return this.platformService.createDiscount(id, dto);
  }

  @Delete('discounts/:id')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a discount' })
  @ApiParam({ name: 'id', description: 'Discount ID' })
  async removeDiscount(@Param('id') id: string) {
    await this.platformService.deleteDiscount(id);
    return { message: 'Discount deleted successfully' };
  }
}

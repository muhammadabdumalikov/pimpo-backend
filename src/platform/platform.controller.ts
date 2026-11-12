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
import {
  CreatePlatformBusinessDto,
  UpdatePlatformBusinessDto,
} from './dto/create-platform-business.dto';
import { TopUpBalanceDto, CreateDiscountDto } from '../subscription/dto/billing.dto';
import { ymdOrUndefined } from '../common/business-time';
import { BillingService } from '../billing/billing.service';
import {
  AdjustBalanceDto,
  ApprovePaymentRequestDto,
  PAYMENT_REQUEST_FILTERS,
  PaymentRequestFilter,
  PaymentRequisitesDto,
  RejectPaymentRequestDto,
} from '../billing/dto/billing.dto';

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
    private readonly billingService: BillingService,
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
  @ApiQuery({ name: 'from', required: false, description: 'Shops registered from this day (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Shops registered up to this day (YYYY-MM-DD)' })
  getStats(@Query('from') from?: string, @Query('to') to?: string) {
    return this.platformService.getStats(ymdOrUndefined(from), ymdOrUndefined(to));
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

  @Get('businesses/:id/stats')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({summary: 'Shop activity (sale counts) and size vs plan'})
  @ApiParam({name: 'id', description: 'Business ID'})
  getBusinessStats(@Param('id') id: string) {
    return this.platformService.getBusinessStats(id);
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
  updateBusiness(@Param('id') id: string, @Body() dto: UpdatePlatformBusinessDto) {
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
    return this.platformService.setSubscription(id, dto.tier, dto.endDate, dto.isTrial);
  }

  @Post('businesses/:id/topup')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Credit a business's prepaid balance" })
  @ApiParam({ name: 'id', description: 'Business ID' })
  topUp(@Param('id') id: string, @Body() dto: TopUpBalanceDto) {
    return this.platformService.topUpBalance(id, dto.amount, dto.note);
  }

  @Post('businesses/:id/adjust')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Signed balance correction with a note (never below zero)' })
  @ApiParam({ name: 'id', description: 'Business ID' })
  @ApiResponse({ status: 409, description: 'BILLING_INSUFFICIENT_BALANCE' })
  adjust(@Param('id') id: string, @Body() dto: AdjustBalanceDto) {
    return this.platformService.adjustBalance(id, dto.amount, dto.note);
  }

  @Get('businesses/:id/transactions')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: "A business's balance ledger, with internal notes" })
  @ApiParam({ name: 'id', description: 'Business ID' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listTransactions(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.platformService.listTransactions(
      id,
      Number(page) || 1,
      Number(limit) || 20,
    );
  }

  // ── Payment requests ("To'lovlar" queue) ───────────────────────────────────

  @Get('payment-requests')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: "Shops' payment requests: the review queue and its history" })
  @ApiQuery({ name: 'status', required: false, enum: PAYMENT_REQUEST_FILTERS })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listPaymentRequests(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const filter = (PAYMENT_REQUEST_FILTERS as readonly string[]).includes(status ?? '')
      ? (status as PaymentRequestFilter)
      : 'pending';
    return this.billingService.listPaymentRequests({
      status: filter,
      page: Number(page) || 1,
      limit: Number(limit) || 20,
    });
  }

  @Post('payment-requests/:id/approve')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve: credit the balance (then renew if it now covers the month)' })
  @ApiParam({ name: 'id', description: 'Payment request ID' })
  approvePaymentRequest(@Param('id') id: string, @Body() dto: ApprovePaymentRequestDto) {
    return this.billingService.approvePaymentRequest(id, dto);
  }

  @Post('payment-requests/:id/reject')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a payment request; the reason is shown to the shop' })
  @ApiParam({ name: 'id', description: 'Payment request ID' })
  rejectPaymentRequest(@Param('id') id: string, @Body() dto: RejectPaymentRequestDto) {
    return this.billingService.rejectPaymentRequest(id, dto.reason);
  }

  // ── Platform settings ──────────────────────────────────────────────────────

  @Get('settings/payment-requisites')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Where shops send money (shown in the payment window)' })
  getRequisites() {
    return this.billingService.getRequisites();
  }

  @Put('settings/payment-requisites')
  @UseGuards(PlatformJwtGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edit the payment requisites (omitted keys are kept, null clears)' })
  setRequisites(@Body() dto: PaymentRequisitesDto) {
    return this.billingService.setRequisites(dto);
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

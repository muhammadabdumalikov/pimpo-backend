import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount, IBusiness} from '../business/types';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import {PlatformAdminGuard} from '../subscription/platform-admin.guard';
import {TopUpBalanceDto} from '../subscription/dto/billing.dto';
import {BillingService} from './billing.service';
import {ChangePlanDto, CreatePaymentRequestDto} from './dto/billing.dto';

/**
 * The shop's side of subscription billing (OBUNA-TOLOV.md §6.1), mounted on
 * /subscriptions next to SubscriptionController. The self-serve plan change
 * lives here because it charges the balance.
 */
@ApiTags('subscriptions')
@Controller('subscriptions')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('billing-status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary:
      'Billing stage for the banner (any staff; amounts only for payers)',
  })
  getStatus(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
  ) {
    return this.billing.getBillingStatus(business.id, account);
  }

  @Get('payment-info')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('settings:manage')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Amount due, payment requisites and the payment request state',
  })
  getPaymentInfo(@CurrentBusiness() business: IBusiness) {
    return this.billing.getPaymentInfo(business.id);
  }

  @Post('payment-requests')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('settings:manage')
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '"To\'lov qildim" — ask the platform to credit a payment',
  })
  @ApiResponse({status: 409, description: 'PAYMENT_REQUEST_ALREADY_PENDING'})
  createPaymentRequest(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreatePaymentRequestDto,
  ) {
    return this.billing.createPaymentRequest(business, account, dto);
  }

  @Get('transactions')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('settings:manage')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Balance history ("To\'lovlar tarixi"), newest first',
  })
  @ApiQuery({name: 'page', required: false})
  @ApiQuery({name: 'limit', required: false})
  listTransactions(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.billing.listTransactions(business.id, {
      page: Number(page) || 1,
      limit: Number(limit) || 20,
    });
  }

  @Get('change-preview')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('settings:manage')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'What switching to `tier` would charge and when it takes effect',
  })
  @ApiQuery({name: 'tier', required: true})
  previewChange(
    @CurrentBusiness() business: IBusiness,
    @Query('tier') tier: string,
  ) {
    return this.billing.previewPlanChange(business, String(tier ?? ''));
  }

  @Post('subscribe')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('settings:manage')
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Subscribe / switch plan (charges the balance; never open-ended)',
  })
  @ApiResponse({status: 409, description: 'BILLING_INSUFFICIENT_BALANCE'})
  @ApiResponse({status: 403, description: 'SUBSCRIPTION_MANAGED_BY_ADMIN'})
  subscribe(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: ChangePlanDto,
  ) {
    return this.billing.changePlan(business, account, dto.tier);
  }

  @Put('current')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('settings:manage')
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change plan (charges the balance; never open-ended)',
  })
  @ApiResponse({status: 409, description: 'BILLING_INSUFFICIENT_BALANCE'})
  @ApiResponse({status: 403, description: 'SUBSCRIPTION_MANAGED_BY_ADMIN'})
  changePlan(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: ChangePlanDto,
  ) {
    return this.billing.changePlan(business, account, dto.tier);
  }

  // Legacy X-Admin-Token top-up, kept for existing callers — now through the
  // same ledger as the platform console.
  @Post('billing/:businessId/topup')
  @UseGuards(PlatformAdminGuard)
  @ApiHeader({
    name: 'X-Admin-Token',
    required: true,
    description: 'Platform admin token',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Credit a business's prepaid balance (platform admin only)",
  })
  @ApiParam({name: 'businessId', description: 'Business ID'})
  async topUpBalance(
    @Param('businessId') businessId: string,
    @Body() dto: TopUpBalanceDto,
  ) {
    const profile = await this.billing.topUp(businessId, dto.amount, dto.note);
    return {message: 'Balance topped up successfully', profile};
  }
}

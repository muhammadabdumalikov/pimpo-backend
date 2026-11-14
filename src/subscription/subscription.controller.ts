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
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiHeader,
} from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import { isBusinessType } from '../common/business-type';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import {
  UpdateBillingProfileDto,
  CreateDiscountDto,
} from './dto/billing.dto';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';

@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  // ============================================
  // PUBLIC ENDPOINTS - Subscription Plans
  // ============================================

  @Get('plans')
  @ApiOperation({ summary: 'Get all available subscription plans (public)' })
  @ApiResponse({
    status: 200,
    description: 'List of subscription plans',
  })
  async getPlans(@Query('type') type?: string) {
    // ?type=food lists the fast-food plan, ?type=online the online seller
    // plan; anything else the shop plans.
    return await this.subscriptionService.getAllPlans(
      isBusinessType(type) ? type : 'retail',
    );
  }

  @Get('plans/:id')
  @ApiOperation({ summary: 'Get a subscription plan by ID (public)' })
  @ApiParam({ name: 'id', description: 'Plan ID' })
  @ApiResponse({
    status: 200,
    description: 'Plan details',
  })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async getPlanById(@Param('id') planId: string) {
    const plan = await this.subscriptionService.getPlanById(planId);
    if (!plan) {
      throw new AppException(ErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND, { planId });
    }
    return plan;
  }

  // ============================================
  // BUSINESS ENDPOINTS - Manage Own Subscription
  // ============================================

  @Get('current')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current business subscription' })
  @ApiResponse({
    status: 200,
    description: 'Current subscription details',
  })
  @ApiResponse({ status: 404, description: 'No active subscription found' })
  async getCurrent(@CurrentBusiness() business: IBusiness) {
    return this.subscriptionService.getCurrentView(business.id);
  }

  @Get('limits')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get subscription limits for current business' })
  @ApiResponse({
    status: 200,
    description: 'Subscription limits (debts and products)',
  })
  async getLimits(@CurrentBusiness() business: IBusiness) {
    return await this.subscriptionService.getSubscriptionLimits(business.id);
  }

  @Get('billing')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary:
      'Get billing info for current business: balance, legal details, monthly breakdown, discounts',
  })
  @ApiResponse({ status: 200, description: 'Billing info' })
  async getBilling(@CurrentBusiness() business: IBusiness) {
    return await this.subscriptionService.getBillingInfo(business.id);
  }

  // POST /subscriptions/subscribe and PUT /subscriptions/current (self-serve
  // plan change) live in BillingController: they charge the balance.

  @Delete('current')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('settings:manage')
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel current subscription (business)' })
  @ApiResponse({
    status: 200,
    description: 'Subscription cancelled successfully',
  })
  async cancelSubscription(@CurrentBusiness() business: IBusiness) {
    await this.subscriptionService.cancelBusinessSubscription(business.id);
    return {
      message: 'Subscription cancelled successfully',
    };
  }

  // ============================================
  // ADMIN ENDPOINTS - Manage Subscription Plans
  // ============================================

  @Post('plans')
  @UseGuards(PlatformAdminGuard)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Platform admin token' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new subscription plan (platform admin only)' })
  @ApiResponse({
    status: 201,
    description: 'Plan created successfully',
  })
  @ApiResponse({ status: 409, description: 'Plan tier already exists' })
  async createPlan(@Body() createPlanDto: CreatePlanDto) {
    const plan = await this.subscriptionService.createPlan(createPlanDto);
    return {
      message: 'Plan created successfully',
      plan,
    };
  }

  @Put('plans/:id')
  @UseGuards(PlatformAdminGuard)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Platform admin token' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a subscription plan (platform admin only)' })
  @ApiParam({ name: 'id', description: 'Plan ID' })
  @ApiResponse({
    status: 200,
    description: 'Plan updated successfully',
  })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async updatePlan(
    @Param('id') planId: string,
    @Body() updatePlanDto: UpdatePlanDto,
  ) {
    const plan = await this.subscriptionService.updatePlan(planId, updatePlanDto);
    return {
      message: 'Plan updated successfully',
      plan,
    };
  }

  @Delete('plans/:id')
  @UseGuards(PlatformAdminGuard)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Platform admin token' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete (deactivate) a subscription plan (platform admin only)' })
  @ApiParam({ name: 'id', description: 'Plan ID' })
  @ApiResponse({
    status: 200,
    description: 'Plan deleted successfully',
  })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async deletePlan(@Param('id') planId: string) {
    await this.subscriptionService.deletePlan(planId);
    return {
      message: 'Plan deleted successfully',
    };
  }

  // ============================================
  // ADMIN ENDPOINTS - Billing (balance / legal details / discounts)
  // ============================================

  @Put('billing/:businessId/profile')
  @UseGuards(PlatformAdminGuard)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Platform admin token' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update a business's billing legal details (platform admin only)" })
  @ApiParam({ name: 'businessId', description: 'Business ID' })
  async updateBillingProfile(
    @Param('businessId') businessId: string,
    @Body() dto: UpdateBillingProfileDto,
  ) {
    const profile = await this.subscriptionService.updateBillingProfile(
      businessId,
      dto,
    );
    return { message: 'Billing profile updated successfully', profile };
  }

  // POST billing/:businessId/topup lives in BillingController: it goes
  // through the balance ledger.

  @Post('billing/:businessId/discounts')
  @UseGuards(PlatformAdminGuard)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Platform admin token' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Grant a promo discount to a business (platform admin only)' })
  @ApiParam({ name: 'businessId', description: 'Business ID' })
  async createDiscount(
    @Param('businessId') businessId: string,
    @Body() dto: CreateDiscountDto,
  ) {
    const discount = await this.subscriptionService.createDiscount(
      businessId,
      dto,
    );
    return { message: 'Discount created successfully', discount };
  }

  @Delete('billing/discounts/:id')
  @UseGuards(PlatformAdminGuard)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Platform admin token' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a discount (platform admin only)' })
  @ApiParam({ name: 'id', description: 'Discount ID' })
  async deleteDiscount(@Param('id') discountId: string) {
    await this.subscriptionService.deleteDiscount(discountId);
    return { message: 'Discount deleted successfully' };
  }

}

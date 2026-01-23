import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export class UpdateSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  @IsEnum(['free', 'basic', 'pro'])
  tier: 'free' | 'basic' | 'pro';
}

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
  async getPlans() {
    return await this.subscriptionService.getAllPlans();
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
      throw new NotFoundException(`Plan with id ${planId} not found`);
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
    const subscription = await this.subscriptionService.getBusinessSubscription(
      business.id,
    );
    
    if (!subscription) {
      // Return default free plan if no subscription
      const freePlan = await this.subscriptionService.getPlanByTier('free');
      return {
        plan: freePlan,
        tier: freePlan?.tier || 'free',
        isActive: true,
      };
    }

    return {
      plan: subscription.plan,
      tier: subscription.plan.tier,
      isActive: subscription.isActive,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
    };
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

  // Business endpoints for managing their own subscription
  @Post('subscribe')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Subscribe to a plan (business)' })
  @ApiResponse({
    status: 201,
    description: 'Subscription created successfully',
  })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async subscribe(
    @CurrentBusiness() business: IBusiness,
    @Body() subscribeDto: UpdateSubscriptionDto,
  ) {
    const subscription = await this.subscriptionService.updateBusinessSubscription(
      business.id,
      subscribeDto.tier,
    );

    return {
      message: 'Subscription created successfully',
      subscription: {
        plan: subscription.plan,
        tier: subscription.plan.tier,
        isActive: subscription.isActive,
        startDate: subscription.startDate,
      },
    };
  }

  @Put('current')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change subscription plan (business)' })
  @ApiResponse({
    status: 200,
    description: 'Subscription changed successfully',
  })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async changeSubscription(
    @CurrentBusiness() business: IBusiness,
    @Body() updateDto: UpdateSubscriptionDto,
  ) {
    const subscription = await this.subscriptionService.updateBusinessSubscription(
      business.id,
      updateDto.tier,
    );

    return {
      message: 'Subscription changed successfully',
      subscription: {
        plan: subscription.plan,
        tier: subscription.plan.tier,
        isActive: subscription.isActive,
        startDate: subscription.startDate,
      },
    };
  }

  @Delete('current')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new subscription plan (admin only)' })
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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a subscription plan (admin only)' })
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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete (deactivate) a subscription plan (admin only)' })
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

}

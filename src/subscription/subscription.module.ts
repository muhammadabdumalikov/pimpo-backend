import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { PlanTierGuard } from './plan-tier.guard';
import { AiUsageService } from './ai-usage.service';
import { UsdRateService } from './usd-rate.service';
import { SubscriptionLockInterceptor } from './subscription-lock.interceptor';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [SubscriptionController],
  providers: [
    SubscriptionService,
    PlanTierGuard,
    AiUsageService,
    UsdRateService,
    // Global: closes every signed-in route of a shop past its grace period,
    // except those marked @AllowWhenLocked().
    { provide: APP_INTERCEPTOR, useClass: SubscriptionLockInterceptor },
  ],
  exports: [SubscriptionService, PlanTierGuard, AiUsageService, UsdRateService],
})
export class SubscriptionModule {}

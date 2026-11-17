import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { PlanTierGuard } from './plan-tier.guard';
import { SubscriptionLockInterceptor } from './subscription-lock.interceptor';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [SubscriptionController],
  providers: [
    SubscriptionService,
    PlanTierGuard,
    // Global: closes every signed-in route of a shop past its grace period,
    // except those marked @AllowWhenLocked().
    { provide: APP_INTERCEPTOR, useClass: SubscriptionLockInterceptor },
  ],
  exports: [SubscriptionService, PlanTierGuard],
})
export class SubscriptionModule {}

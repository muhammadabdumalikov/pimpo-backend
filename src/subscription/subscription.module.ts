import { Module } from '@nestjs/common';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { PlanTierGuard } from './plan-tier.guard';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [SubscriptionController],
  providers: [SubscriptionService, PlanTierGuard],
  exports: [SubscriptionService, PlanTierGuard],
})
export class SubscriptionModule {}

import { Module } from '@nestjs/common';
import { BranchController } from './branch.controller';
import { BranchService } from './branch.service';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule, BillingModule],
  controllers: [BranchController],
  providers: [BranchService],
  exports: [BranchService],
})
export class BranchModule {}

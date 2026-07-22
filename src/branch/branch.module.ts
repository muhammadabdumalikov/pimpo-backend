import { Module } from '@nestjs/common';
import { BranchController } from './branch.controller';
import { BranchService } from './branch.service';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule],
  controllers: [BranchController],
  providers: [BranchService],
  exports: [BranchService],
})
export class BranchModule {}

import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { BusinessService } from '../business/business.service';
import { UserModule } from '../user/user.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { BranchModule } from '../branch/branch.module';

@Module({
  imports: [UserModule, SubscriptionModule, BranchModule],
  controllers: [OrderController],
  providers: [OrderService, BusinessService],
  exports: [OrderService],
})
export class OrderModule {}

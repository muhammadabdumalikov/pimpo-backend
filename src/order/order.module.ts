import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { SaleReturnService } from './sale-return.service';
import { SaleReturnController } from './sale-return.controller';
import { BusinessService } from '../business/business.service';
import { UserModule } from '../user/user.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { BranchModule } from '../branch/branch.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [UserModule, SubscriptionModule, BranchModule, TelegramModule],
  controllers: [OrderController, SaleReturnController],
  providers: [OrderService, SaleReturnService, BusinessService],
  exports: [OrderService, SaleReturnService],
})
export class OrderModule {}

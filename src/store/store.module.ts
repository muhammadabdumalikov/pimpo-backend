import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { CategoryModule } from '../category/category.module';
import { OrderModule } from '../order/order.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [CategoryModule, OrderModule, SubscriptionModule],
  controllers: [StoreController],
  providers: [StoreService],
})
export class StoreModule {}

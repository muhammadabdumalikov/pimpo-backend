import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { CategoryModule } from '../category/category.module';
import { OrderModule } from '../order/order.module';

@Module({
  imports: [CategoryModule, OrderModule],
  controllers: [StoreController],
  providers: [StoreService],
})
export class StoreModule {}

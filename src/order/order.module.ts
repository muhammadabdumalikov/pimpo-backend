import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { BusinessService } from '../business/business.service';

@Module({
  controllers: [OrderController],
  providers: [OrderService, BusinessService],
  exports: [OrderService],
})
export class OrderModule {}

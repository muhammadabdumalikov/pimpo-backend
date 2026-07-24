import {Module} from '@nestjs/common';
import {
  StockTakeController,
  WriteOffController,
} from './stock-take.controller';
import {StockTakeService} from './stock-take.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule],
  controllers: [StockTakeController, WriteOffController],
  providers: [StockTakeService],
  exports: [StockTakeService],
})
export class StockTakeModule {}

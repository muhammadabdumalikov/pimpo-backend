import {Module} from '@nestjs/common';
import {FinanceController} from './finance.controller';
import {FinanceService} from './finance.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}

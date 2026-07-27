import {Module} from '@nestjs/common';
import {PayrollController} from './payroll.controller';
import {PayrollService} from './payroll.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {FinanceModule} from '../finance/finance.module';
import {SubscriptionModule} from '../subscription/subscription.module';

@Module({
  imports: [DatabaseModule, BusinessModule, FinanceModule, SubscriptionModule],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}

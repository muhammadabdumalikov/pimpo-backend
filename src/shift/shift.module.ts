import {Module} from '@nestjs/common';
import {ShiftController} from './shift.controller';
import {ShiftService} from './shift.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {FinanceModule} from '../finance/finance.module';

@Module({
  imports: [DatabaseModule, BusinessModule, FinanceModule],
  controllers: [ShiftController],
  providers: [ShiftService],
  exports: [ShiftService],
})
export class ShiftModule {}

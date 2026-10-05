import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {PermissionModule} from '../permission/permission.module';
import {ReportModule} from '../report/report.module';
import {OrderModule} from '../order/order.module';
import {ShiftModule} from '../shift/shift.module';
import {TargetModule} from '../target/target.module';
import {BranchModule} from '../branch/branch.module';
import {FinanceModule} from '../finance/finance.module';
import {MobileController} from './mobile.controller';
import {MobileService} from './mobile.service';

@Module({
  imports: [
    DatabaseModule,
    BusinessModule,
    SubscriptionModule,
    PermissionModule,
    ReportModule,
    OrderModule,
    ShiftModule,
    TargetModule,
    BranchModule,
    FinanceModule,
  ],
  controllers: [MobileController],
  providers: [MobileService],
})
export class MobileModule {}

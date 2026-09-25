import {Module} from '@nestjs/common';
import {ReportController} from './report.controller';
import {ReportService} from './report.service';
import {LossesReportService} from './losses-report.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule],
  controllers: [ReportController],
  providers: [ReportService, LossesReportService],
  exports: [ReportService],
})
export class ReportModule {}

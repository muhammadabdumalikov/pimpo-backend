import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { BusinessService } from '../business/business.service';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [SubscriptionModule],
  controllers: [StaffController],
  providers: [StaffService, BusinessService],
  exports: [StaffService],
})
export class StaffModule {}

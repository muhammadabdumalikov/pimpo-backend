import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { BusinessService } from '../business/business.service';

@Module({
  controllers: [StaffController],
  providers: [StaffService, BusinessService],
  exports: [StaffService],
})
export class StaffModule {}

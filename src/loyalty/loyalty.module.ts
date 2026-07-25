import { Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { BusinessService } from '../business/business.service';

@Module({
  controllers: [LoyaltyController],
  providers: [LoyaltyService, BusinessService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}

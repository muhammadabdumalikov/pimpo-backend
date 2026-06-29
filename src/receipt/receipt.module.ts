import { Module } from '@nestjs/common';
import { ReceiptController } from './receipt.controller';
import { ReceiptService } from './receipt.service';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [ReceiptController],
  providers: [ReceiptService],
  exports: [ReceiptService],
})
export class ReceiptModule {}

import { Module } from '@nestjs/common';
import { ReceiptController } from './receipt.controller';
import { ReceiptService } from './receipt.service';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';
import { FinanceModule } from '../finance/finance.module';

@Module({
  imports: [DatabaseModule, BusinessModule, FinanceModule],
  controllers: [ReceiptController],
  providers: [ReceiptService],
  exports: [ReceiptService],
})
export class ReceiptModule {}

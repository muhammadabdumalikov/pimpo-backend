import {Module} from '@nestjs/common';
import {StockTransferController} from './stock-transfer.controller';
import {StockTransferService} from './stock-transfer.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [StockTransferController],
  providers: [StockTransferService],
  exports: [StockTransferService],
})
export class StockTransferModule {}

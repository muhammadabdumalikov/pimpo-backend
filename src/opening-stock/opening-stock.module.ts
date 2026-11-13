import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {StockTransferModule} from '../stock-transfer/stock-transfer.module';
import {OpeningStockController} from './opening-stock.controller';
import {OpeningStockService} from './opening-stock.service';

@Module({
  imports: [DatabaseModule, BusinessModule, StockTransferModule],
  controllers: [OpeningStockController],
  providers: [OpeningStockService],
})
export class OpeningStockModule {}

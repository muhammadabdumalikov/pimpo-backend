import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {ReceiptTemplateController} from './receipt-template.controller';
import {ReceiptTemplateService} from './receipt-template.service';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [ReceiptTemplateController],
  providers: [ReceiptTemplateService],
  exports: [ReceiptTemplateService],
})
export class ReceiptTemplateModule {}

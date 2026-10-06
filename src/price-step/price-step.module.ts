import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {TelegramModule} from '../telegram/telegram.module';
import {PriceStepController} from './price-step.controller';
import {PriceStepService} from './price-step.service';

@Module({
  imports: [DatabaseModule, BusinessModule, TelegramModule],
  controllers: [PriceStepController],
  providers: [PriceStepService],
  exports: [PriceStepService],
})
export class PriceStepModule {}

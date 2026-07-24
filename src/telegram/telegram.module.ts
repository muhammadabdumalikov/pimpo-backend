import {Module} from '@nestjs/common';
import {TelegramController} from './telegram.controller';
import {TelegramSenderService} from './telegram-sender.service';
import {TelegramBotService} from './telegram-bot.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [TelegramController],
  providers: [TelegramSenderService, TelegramBotService],
  exports: [TelegramSenderService],
})
export class TelegramModule {}

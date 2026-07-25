import {Module} from '@nestjs/common';
import {TelegramController} from './telegram.controller';
import {TelegramSenderService} from './telegram-sender.service';
import {TelegramBotService} from './telegram-bot.service';
import {TelegramNotifyService} from './telegram-notify.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [TelegramController],
  providers: [TelegramSenderService, TelegramBotService, TelegramNotifyService],
  // TelegramNotifyService is consumed by order/shift/digest to push per-event
  // notifications; TelegramSenderService stays exported for existing callers.
  exports: [TelegramSenderService, TelegramNotifyService],
})
export class TelegramModule {}

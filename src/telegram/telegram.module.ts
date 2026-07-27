import {Module} from '@nestjs/common';
import {BullModule} from '@nestjs/bullmq';
import {TelegramController} from './telegram.controller';
import {TelegramSenderService} from './telegram-sender.service';
import {TelegramBotService} from './telegram-bot.service';
import {TelegramNotifyService} from './telegram-notify.service';
import {TelegramNotificationsProcessor} from './telegram-notifications.processor';
import {TELEGRAM_QUEUE} from './telegram.constants';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {resolveRedisConnection, envGetter} from '../common/redis-config';

// Redis presence decides whether notifications go through the BullMQ queue.
// Evaluated at module-load time — main.ts loads .env first, so REDIS_* is
// visible here in local dev too. When Redis is absent we register neither the
// queue nor the worker, and TelegramNotifyService falls back to direct sends.
const redisConnection = resolveRedisConnection(envGetter());

const bullImports = redisConnection
  ? [
      BullModule.forRoot({connection: redisConnection, prefix: 'pimpo:bull'}),
      BullModule.registerQueue({
        name: TELEGRAM_QUEUE,
        defaultJobOptions: {
          // Retry a failed delivery (e.g. Telegram 429/network) with backoff.
          attempts: 5,
          backoff: {type: 'exponential', delay: 3000},
          // Keep the queue from growing unbounded in Redis.
          removeOnComplete: {age: 3600, count: 1000},
          removeOnFail: {age: 86400},
        },
      }),
    ]
  : [];

const bullProviders = redisConnection ? [TelegramNotificationsProcessor] : [];

@Module({
  imports: [
    DatabaseModule,
    BusinessModule,
    SubscriptionModule,
    ...bullImports,
  ],
  controllers: [TelegramController],
  providers: [
    TelegramSenderService,
    TelegramBotService,
    TelegramNotifyService,
    ...bullProviders,
  ],
  // TelegramNotifyService is consumed by order/shift/digest to push per-event
  // notifications; TelegramSenderService stays exported for existing callers.
  exports: [TelegramSenderService, TelegramNotifyService],
})
export class TelegramModule {}

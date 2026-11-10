import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {TelegramModule} from '../telegram/telegram.module';
import {BillingController} from './billing.controller';
import {BillingService} from './billing.service';
import {BillingCronService} from './billing-cron.service';

// Separate from SubscriptionModule because billing notifies through Telegram,
// and TelegramModule already imports SubscriptionModule. Consumed by branch
// (seat charges), platform (console) and mobile (attention card).
@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule, TelegramModule],
  controllers: [BillingController],
  providers: [BillingService, BillingCronService],
  exports: [BillingService],
})
export class BillingModule {}

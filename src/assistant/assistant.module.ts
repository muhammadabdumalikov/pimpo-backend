import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {FeatureModule} from '../feature/feature.module';
import {TelegramModule} from '../telegram/telegram.module';
import {OrderModule} from '../order/order.module';
import {AssistantService} from './assistant.service';
import {AssistantToolsService} from './assistant-tools';
import {AssistantHandoffService} from './assistant-handoff.service';
import {AssistantSettingsService} from './assistant-settings.service';
import {AssistantTelegram} from './assistant-telegram';
import {InboxService} from './inbox.service';
import {InboxController} from './inbox.controller';
import {
  AssistantSettingsController,
  AssistantWebhookController,
} from './assistant.controller';

/** AI yordamchi — see AI-YORDAMCHI.md. */
@Module({
  imports: [
    DatabaseModule,
    BusinessModule,
    SubscriptionModule,
    FeatureModule,
    TelegramModule,
    OrderModule,
  ],
  controllers: [AssistantWebhookController, AssistantSettingsController, InboxController],
  providers: [
    AssistantService,
    AssistantToolsService,
    AssistantHandoffService,
    AssistantSettingsService,
    AssistantTelegram,
    InboxService,
  ],
})
export class AssistantModule {}

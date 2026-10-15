import {Module} from '@nestjs/common';
import {BusinessModule} from '../../business/business.module';
import {DatabaseModule} from '../../database/database.module';
import {FeatureModule} from '../../feature/feature.module';
import {SubscriptionModule} from '../../subscription/subscription.module';
import {TelegramModule} from '../../telegram/telegram.module';
import {AiImagePlatformController} from './ai-image-platform.controller';
import {AiImageController} from './ai-image.controller';
import {AiImageService} from './ai-image.service';

/**
 * AI product packshots (AI-RASM.md). Its own module, apart from AiModule:
 * that one spends the shop's BYOK key, this one spends Pimpo's.
 *
 * BusinessModule / SubscriptionModule / FeatureModule are for the guards
 * (JwtAuthGuard, PlanTierGuard, FeatureGuard); TelegramModule for the budget
 * alert. StorageModule and PermissionModule are global.
 */
@Module({
  imports: [
    DatabaseModule,
    BusinessModule,
    SubscriptionModule,
    FeatureModule,
    TelegramModule,
  ],
  controllers: [AiImageController, AiImagePlatformController],
  providers: [AiImageService],
})
export class AiImageModule {}

import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import {
  StoreBannerPublicController,
  StoreBannerSettingsController,
  StoreBrandingSettingsController,
} from './store-banner.controller';
import { StoreBannerService } from './store-banner.service';
import { BusinessService } from '../business/business.service';
import { CategoryModule } from '../category/category.module';
import { OrderModule } from '../order/order.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [CategoryModule, OrderModule, SubscriptionModule],
  controllers: [
    StoreController,
    StoreBannerPublicController,
    StoreBannerSettingsController,
    StoreBrandingSettingsController,
  ],
  // BusinessService: JwtAuthGuard on the banner / branding settings controllers.
  providers: [StoreService, StoreBannerService, BusinessService],
})
export class StoreModule {}

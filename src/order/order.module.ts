import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { SaleReturnService } from './sale-return.service';
import { SaleReturnController } from './sale-return.controller';
import { BusinessService } from '../business/business.service';
import { UserModule } from '../user/user.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { BranchModule } from '../branch/branch.module';
import { TelegramModule } from '../telegram/telegram.module';
import { FeatureModule } from '../feature/feature.module';
import { PriceStepModule } from '../price-step/price-step.module';
import { OnlineOrderService } from './online-order.service';
import { StoreSettingsService } from './store-settings.service';
import {
  OnlineOrderController,
  StoreDeliverySettingsController,
} from './online-order.controller';

@Module({
  imports: [UserModule, SubscriptionModule, BranchModule, TelegramModule, FeatureModule, PriceStepModule],
  controllers: [
    OrderController,
    SaleReturnController,
    OnlineOrderController,
    StoreDeliverySettingsController,
  ],
  providers: [
    OrderService,
    SaleReturnService,
    BusinessService,
    OnlineOrderService,
    StoreSettingsService,
  ],
  exports: [
    OrderService,
    SaleReturnService,
    OnlineOrderService,
    StoreSettingsService,
  ],
})
export class OrderModule {}

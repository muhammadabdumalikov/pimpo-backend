import {Module} from '@nestjs/common';
import {ProductModule} from '../product/product.module';
import {DigestController} from './digest.controller';
import {DigestService} from './digest.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {TelegramModule} from '../telegram/telegram.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule, TelegramModule, ProductModule],
  controllers: [DigestController],
  providers: [DigestService],
  exports: [DigestService],
})
export class DigestModule {}

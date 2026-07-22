import {Module} from '@nestjs/common';
import {DigestController} from './digest.controller';
import {DigestService} from './digest.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule],
  controllers: [DigestController],
  providers: [DigestService],
  exports: [DigestService],
})
export class DigestModule {}

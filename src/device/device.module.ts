import {Module} from '@nestjs/common';
import {BusinessModule} from '../business/business.module';
import {DatabaseModule} from '../database/database.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {DeviceAuthGuard} from './device-auth.guard';
import {DeviceController} from './device.controller';
import {DeviceService} from './device.service';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule],
  controllers: [DeviceController],
  providers: [DeviceService, DeviceAuthGuard],
  exports: [DeviceService, DeviceAuthGuard],
})
export class DeviceModule {}

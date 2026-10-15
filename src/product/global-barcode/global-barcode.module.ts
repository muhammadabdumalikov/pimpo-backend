import {Module} from '@nestjs/common';
import {DatabaseModule} from '../../database/database.module';
import {SubscriptionModule} from '../../subscription/subscription.module';
import {GlobalBarcodePlatformController} from './global-barcode-platform.controller';
import {GlobalBarcodeService} from './global-barcode.service';

/**
 * The shared barcode catalogue as the platform curates it. Shops still write
 * to it from ProductService (first picture wins); this module is the only
 * place that replaces one. StorageModule is global.
 */
@Module({
  imports: [DatabaseModule, SubscriptionModule],
  controllers: [GlobalBarcodePlatformController],
  providers: [GlobalBarcodeService],
})
export class GlobalBarcodeModule {}

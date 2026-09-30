import {Module} from '@nestjs/common';
import {DefectiveController} from './defective.controller';
import {DefectiveService} from './defective.service';
import {SupplierDefectiveService} from './supplier-defective.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {FeatureModule} from '../feature/feature.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule, FeatureModule],
  controllers: [DefectiveController],
  providers: [DefectiveService, SupplierDefectiveService],
  // The supplier pages read defective stock from their side.
  exports: [SupplierDefectiveService],
})
export class DefectiveModule {}

import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {FeatureService} from './feature.service';
import {FeatureGuard} from './feature.guard';
import {FeatureController} from './feature.controller';
import {FeaturePlatformController} from './feature-platform.controller';

/**
 * Feature flags per do'kon. Import this module wherever a controller uses
 * @RequireFeature() + FeatureGuard, the same way SubscriptionModule is
 * imported for @MinTier().
 */
@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [FeatureController, FeaturePlatformController],
  providers: [FeatureService, FeatureGuard],
  exports: [FeatureService, FeatureGuard],
})
export class FeatureModule {}

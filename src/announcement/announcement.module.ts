import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {FeatureModule} from '../feature/feature.module';
import {AnnouncementService} from './announcement.service';
import {AnnouncementController} from './announcement.controller';
import {AnnouncementPlatformController} from './announcement-platform.controller';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule, FeatureModule],
  controllers: [AnnouncementController, AnnouncementPlatformController],
  providers: [AnnouncementService],
})
export class AnnouncementModule {}

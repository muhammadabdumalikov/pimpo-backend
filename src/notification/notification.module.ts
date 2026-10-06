import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {AnnouncementModule} from '../announcement/announcement.module';
import {NotificationController} from './notification.controller';
import {NotificationService} from './notification.service';

// Must not import TelegramModule: TelegramModule imports this one to hand every
// toggled event to the inbox/push (the shared settings helper avoids the cycle).
@Module({
  imports: [DatabaseModule, BusinessModule, AnnouncementModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}

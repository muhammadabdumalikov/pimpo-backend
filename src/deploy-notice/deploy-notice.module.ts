import {Module} from '@nestjs/common';
import {TelegramModule} from '../telegram/telegram.module';
import {DeployNoticeController} from './deploy-notice.controller';
import {DeployNoticeService} from './deploy-notice.service';

/** Deploy changelog, in Uzbek, to the team's Telegram channel. */
@Module({
  imports: [TelegramModule],
  controllers: [DeployNoticeController],
  providers: [DeployNoticeService],
})
export class DeployNoticeModule {}

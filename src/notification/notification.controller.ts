import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount} from '../business/types';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {NotificationService} from './notification.service';
import {
  NotificationListQueryDto,
  SubscribePushDto,
  UnsubscribePushDto,
} from './dto/push-subscription.dto';

// Owner-only (MOBILE.md Q10): the inbox and push go to the business account,
// never to staff, so every route checks the account type itself.
function assertOwner(account: IAccount): void {
  if (account?.type !== 'business') throw new AppException(ErrorCode.OWNER_ONLY);
}

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({summary: 'Owner inbox (🔔), newest first, keyset paged'})
  list(@CurrentAccount() account: IAccount, @Query() q: NotificationListQueryDto) {
    assertOwner(account);
    return this.notifications.list(account.businessId, {
      cursor: q.cursor,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('unread-count')
  @ApiOperation({summary: 'Unread inbox count (for the bell badge)'})
  async unread(@CurrentAccount() account: IAccount) {
    assertOwner(account);
    return {unread: await this.notifications.unreadCount(account.businessId)};
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  readAll(@CurrentAccount() account: IAccount) {
    assertOwner(account);
    return this.notifications.markAllRead(account.businessId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async read(@CurrentAccount() account: IAccount, @Param('id') id: string) {
    assertOwner(account);
    await this.notifications.markRead(account.businessId, id);
    return {ok: true};
  }

  @Get('push/config')
  @ApiOperation({summary: 'Whether push is configured + the VAPID public key'})
  config() {
    return this.notifications.config();
  }

  @Post('push/subscribe')
  @HttpCode(HttpStatus.OK)
  async subscribe(
    @CurrentAccount() account: IAccount,
    @Body() dto: SubscribePushDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    assertOwner(account);
    await this.notifications.subscribe(account.businessId, dto, userAgent);
    return {ok: true};
  }

  @Post('push/unsubscribe')
  @HttpCode(HttpStatus.OK)
  async unsubscribe(@CurrentAccount() account: IAccount, @Body() dto: UnsubscribePushDto) {
    assertOwner(account);
    await this.notifications.unsubscribe(account.businessId, dto.endpoint);
    return {ok: true};
  }

  @Post('push/test')
  @HttpCode(HttpStatus.OK)
  test(@CurrentAccount() account: IAccount) {
    assertOwner(account);
    return this.notifications.test(account.businessId);
  }
}

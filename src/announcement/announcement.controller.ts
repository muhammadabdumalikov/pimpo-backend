import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiParam, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount, IBusiness} from '../business/types';
import {AnnouncementService} from './announcement.service';

/**
 * The in-app "Yangiliklar" bell. Open to every signed-in account — cashiers
 * included — and read receipts are per account, so each person sees a release
 * note once.
 */
@ApiTags('announcements')
@Controller('announcements')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Get()
  @ApiOperation({
    summary:
      'Announcements for the current business, newest first, with read state',
  })
  list(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
  ) {
    return this.announcementService.listForAccount(business.id, account);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark every visible announcement as read for the current account',
  })
  readAll(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
  ) {
    return this.announcementService.markAllRead(business.id, account);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark one announcement as read for the current account',
  })
  @ApiParam({name: 'id', description: 'Announcement ID'})
  async read(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    await this.announcementService.markRead(business.id, account, id);
  }
}

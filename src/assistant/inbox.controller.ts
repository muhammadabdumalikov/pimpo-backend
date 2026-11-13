import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import type {Response} from 'express';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import type {IAccount} from '../business/types';
import {FeatureGuard} from '../feature/feature.guard';
import {RequireFeature} from '../feature/require-feature.decorator';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import {InboxService} from './inbox.service';
import {
  InboxAssignDto,
  InboxBotDto,
  InboxCustomerDto,
  InboxFaqDto,
  InboxFlagDto,
  InboxListQueryDto,
  InboxMessagesQueryDto,
  InboxNoteDto,
  InboxReplyDto,
  QuickReplyDto,
  UpdateQuickReplyDto,
} from './dto/inbox.dto';

/**
 * Murojaatlar — the inbox of customer chats (AI-YORDAMCHI.md, I1). Same gates
 * as the assistant (flag, Business+ plan) and the right to answer customers.
 * Customer details additionally need customer:read (checked in the service).
 */
@ApiTags('inbox')
@Controller('inbox')
@UseGuards(JwtAuthGuard, FeatureGuard, PlanTierGuard, PermissionsGuard)
@RequireFeature('ai_assistant')
@MinTier('proplus')
@RequirePermission('customer:chat:reply')
@ApiBearerAuth('JWT-auth')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get('chats')
  @ApiOperation({summary: 'Chats, newest activity first (50 per page)'})
  list(@CurrentAccount() account: IAccount, @Query() q: InboxListQueryDto) {
    return this.inbox.list(account, q);
  }

  @Get('counts')
  @ApiOperation({summary: 'Per-status counts and unread chats (sidebar badge)'})
  counts(@CurrentAccount() account: IAccount) {
    return this.inbox.counts(account);
  }

  @Get('agents')
  @ApiOperation({summary: 'Who a chat can be assigned to'})
  agents(@CurrentAccount() account: IAccount) {
    return this.inbox.agents(account.businessId);
  }

  @Get('chats/:id')
  @ApiOperation({summary: 'Chat header, assignee, notes and the customer panel'})
  detail(@CurrentAccount() account: IAccount, @Param('id') id: string) {
    return this.inbox.detail(account, id);
  }

  @Get('chats/:id/messages')
  @ApiOperation({summary: 'Messages, oldest first; the newest page marks the chat read'})
  messages(
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Query() q: InboxMessagesQueryDto,
  ) {
    return this.inbox.messages(account, id, q.before);
  }

  @Post('chats/:id/messages')
  @ApiOperation({summary: 'Answer the customer through the shop bot'})
  reply(@CurrentAccount() account: IAccount, @Param('id') id: string, @Body() dto: InboxReplyDto) {
    return this.inbox.reply(account, id, dto.text);
  }

  @Put('chats/:id/bot')
  @ApiOperation({summary: "Botni to'xtatish / botga qaytarish"})
  bot(@CurrentAccount() account: IAccount, @Param('id') id: string, @Body() dto: InboxBotDto) {
    return this.inbox.setBotPaused(account, id, dto.paused);
  }

  @Post('chats/:id/close')
  @ApiOperation({summary: 'Close; the customer writing again reopens it'})
  close(@CurrentAccount() account: IAccount, @Param('id') id: string) {
    return this.inbox.close(account, id);
  }

  @Post('chats/:id/reopen')
  @ApiOperation({summary: 'Reopen a closed chat'})
  reopen(@CurrentAccount() account: IAccount, @Param('id') id: string) {
    return this.inbox.reopen(account, id);
  }

  @Put('chats/:id/assignee')
  @ApiOperation({summary: 'Assign to the owner or a staff member (null = nobody)'})
  assign(@CurrentAccount() account: IAccount, @Param('id') id: string, @Body() dto: InboxAssignDto) {
    return this.inbox.assign(account, id, dto.assigneeId);
  }

  @Put('chats/:id/customer')
  @ApiOperation({summary: 'Link the chat to a KPOS customer (needs customer:read)'})
  customer(@CurrentAccount() account: IAccount, @Param('id') id: string, @Body() dto: InboxCustomerDto) {
    return this.inbox.linkCustomer(account, id, dto.customerId);
  }

  @Post('chats/:id/notes')
  @ApiOperation({summary: 'Internal note (never sent to the customer)'})
  addNote(@CurrentAccount() account: IAccount, @Param('id') id: string, @Body() dto: InboxNoteDto) {
    return this.inbox.addNote(account, id, dto.text);
  }

  @Delete('notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({summary: 'Delete your note (the owner may delete any)'})
  async deleteNote(@CurrentAccount() account: IAccount, @Param('noteId') noteId: string) {
    await this.inbox.deleteNote(account, noteId);
  }

  @Put('messages/:messageId/flag')
  @ApiOperation({summary: 'Mark a bot answer wrong (or clear it)'})
  flag(
    @CurrentAccount() account: IAccount,
    @Param('messageId') messageId: string,
    @Body() dto: InboxFlagDto,
  ) {
    return this.inbox.flagMessage(account, messageId, dto.flag);
  }

  @Get('messages/:messageId/media')
  @ApiOperation({summary: "The customer's photo/file, proxied from Telegram"})
  async media(
    @CurrentAccount() account: IAccount,
    @Param('messageId') messageId: string,
    @Res() res: Response,
  ) {
    const {bytes, contentType} = await this.inbox.media(account, messageId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(bytes);
  }

  @Post('faqs')
  @ApiOperation({summary: "FAQ'ga qo'shish from a chat"})
  addFaq(@CurrentAccount() account: IAccount, @Body() dto: InboxFaqDto) {
    return this.inbox.addFaq(account, dto.question, dto.answer);
  }

  @Get('quick-replies')
  @ApiOperation({summary: 'Saved answers'})
  quickReplies(@CurrentAccount() account: IAccount) {
    return this.inbox.listQuickReplies(account.businessId);
  }

  @Post('quick-replies')
  @ApiOperation({summary: 'Add a saved answer'})
  createQuickReply(@CurrentAccount() account: IAccount, @Body() dto: QuickReplyDto) {
    return this.inbox.createQuickReply(account.businessId, dto.title, dto.text);
  }

  @Put('quick-replies/:qid')
  @ApiOperation({summary: 'Edit a saved answer'})
  updateQuickReply(
    @CurrentAccount() account: IAccount,
    @Param('qid') qid: string,
    @Body() dto: UpdateQuickReplyDto,
  ) {
    return this.inbox.updateQuickReply(account.businessId, qid, dto);
  }

  @Delete('quick-replies/:qid')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({summary: 'Delete a saved answer'})
  async deleteQuickReply(@CurrentAccount() account: IAccount, @Param('qid') qid: string) {
    await this.inbox.deleteQuickReply(account.businessId, qid);
  }
}

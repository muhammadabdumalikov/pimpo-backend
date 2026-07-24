import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import * as multer from 'multer';
import {and, desc, eq} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IBusiness, IAccount} from '../business/types';
import {DatabaseService} from '../database/database.service';
import {
  telegramLinks,
  TelegramLink,
  businesses,
  staff,
} from '../database/schema';
import {TelegramSenderService} from './telegram-sender.service';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// xlsx uploads sometimes arrive with a generic mimetype; accept those only when
// the filename ends with .xlsx.
const FALLBACK_MIMES = ['application/octet-stream', 'application/zip'];

@ApiTags('telegram')
@Controller('telegram')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TelegramController {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly sender: TelegramSenderService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Get('links')
  @ApiOperation({summary: 'List active Telegram links for the business'})
  async listLinks(@CurrentBusiness() business: IBusiness) {
    const rows = await this.db
      .select()
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.businessId, business.id),
          eq(telegramLinks.isActive, true),
        ),
      )
      .orderBy(desc(telegramLinks.createdAt));
    return {links: rows.map((r) => this.toApi(r))};
  }

  @Delete('links/:id')
  @ApiOperation({summary: 'Deactivate a Telegram link owned by the business'})
  @ApiParam({name: 'id', description: 'Telegram link ID'})
  async removeLink(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const [link] = await this.db
      .select()
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.id, id),
          eq(telegramLinks.businessId, business.id),
        ),
      )
      .limit(1);
    if (!link) {
      throw new AppException(ErrorCode.TELEGRAM_LINK_NOT_FOUND);
    }
    await this.db
      .update(telegramLinks)
      .set({isActive: false, updatedAt: new Date()})
      .where(eq(telegramLinks.id, id));
    return {message: 'Telegram link deactivated'};
  }

  @Get('connect-info')
  @ApiOperation({summary: 'Bot username + deep link for connecting a chat'})
  connectInfo(): {botUsername: string | null; deepLink: string | null} {
    const botUsername = this.sender.getBotUsername();
    return {
      botUsername,
      deepLink: botUsername ? `https://t.me/${botUsername}` : null,
    };
  }

  @Post('send-document')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: {fileSize: MAX_FILE_SIZE},
    }),
  )
  @ApiOperation({
    summary: 'Forward an in-memory Excel report to linked Telegram chat(s)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {type: 'string', format: 'binary'},
        linkIds: {
          type: 'string',
          description:
            'Target telegram link IDs — JSON array (e.g. ["a","b"]) OR ' +
            'comma-separated. Omit/empty to send to all active links.',
        },
        caption: {type: 'string'},
      },
    },
  })
  async sendDocument(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @UploadedFile() file: Express.Multer.File,
    @Body('linkIds') linkIdsRaw?: string,
    @Body('caption') caption?: string,
  ): Promise<{sent: number; failed: {linkId: string; error: string}[]}> {
    if (!this.sender.isConfigured()) {
      throw new AppException(ErrorCode.TELEGRAM_NOT_CONFIGURED);
    }
    if (!file?.buffer) {
      throw new AppException(ErrorCode.NO_FILE_PROVIDED);
    }
    this.assertXlsx(file);

    const linkIds = this.parseLinkIds(linkIdsRaw);
    const active = await this.db
      .select()
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.businessId, business.id),
          eq(telegramLinks.isActive, true),
        ),
      );
    // If explicit IDs are given, restrict to them; otherwise send to all active.
    const targets =
      linkIds.length > 0
        ? active.filter((l) => linkIds.includes(l.id))
        : active;
    if (targets.length === 0) {
      throw new AppException(ErrorCode.TELEGRAM_NO_TARGETS);
    }

    // Who sent it — resolved server-side from the JWT (not trusted from the
    // client). Echoed in the caption so chat members see the sender, and stored
    // on each link as lastSentBy for the settings audit.
    const senderName = await this.resolveSenderName(account);
    const finalCaption = [caption?.trim(), `👤 Yubordi: ${senderName}`]
      .filter(Boolean)
      .join('\n');
    const now = new Date();

    const filename = file.originalname || 'report.xlsx';
    let sent = 0;
    const failed: {linkId: string; error: string}[] = [];
    for (const link of targets) {
      try {
        await this.sender.sendDocument(
          link.chatId,
          file.buffer,
          filename,
          finalCaption,
        );
        sent += 1;
        await this.db
          .update(telegramLinks)
          .set({lastSentAt: now, lastSentBy: senderName})
          .where(eq(telegramLinks.id, link.id));
      } catch (e) {
        failed.push({linkId: link.id, error: (e as Error).message});
      }
    }
    // Always 200 with details — the frontend surfaces the per-chat failures.
    return {sent, failed};
  }

  /** Display name of the acting account (owner → business, staff → staff row). */
  private async resolveSenderName(account: IAccount): Promise<string> {
    if (account.type === 'business') {
      const [b] = await this.db
        .select({name: businesses.name})
        .from(businesses)
        .where(eq(businesses.id, account.id))
        .limit(1);
      return b?.name ?? 'Egasi';
    }
    const [s] = await this.db
      .select({name: staff.name})
      .from(staff)
      .where(eq(staff.id, account.id))
      .limit(1);
    return s?.name ?? 'Xodim';
  }

  private toApi(r: TelegramLink) {
    return {
      id: r.id,
      accountType: r.accountType,
      accountId: r.accountId,
      accountLogin: r.accountLogin,
      accountName: r.accountName,
      tgUsername: r.tgUsername,
      tgFirstName: r.tgFirstName,
      chatId: r.chatId,
      createdAt: r.createdAt,
      lastSentAt: r.lastSentAt,
      lastSentBy: r.lastSentBy,
    };
  }

  private assertXlsx(file: Express.Multer.File): void {
    const mime = file.mimetype || '';
    const name = (file.originalname || '').toLowerCase();
    const ok =
      mime === XLSX_MIME ||
      (FALLBACK_MIMES.includes(mime) && name.endsWith('.xlsx'));
    if (!ok) {
      throw new AppException(ErrorCode.INVALID_FILE_TYPE, {allowed: '.xlsx'});
    }
  }

  /** Parse linkIds sent as a JSON array string or a comma-separated list. */
  private parseLinkIds(raw?: string): string[] {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (x): x is string => typeof x === 'string' && x.length > 0,
          );
        }
      } catch {
        // Not valid JSON — fall through to CSV parsing.
      }
    }
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}

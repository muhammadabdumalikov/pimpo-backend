import {
  Controller,
  Get,
  Post,
  Put,
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
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IBusiness, IAccount} from '../business/types';
import {DatabaseService} from '../database/database.service';
import {
  telegramLinks,
  TelegramLink,
  businesses,
  staff,
  storeBots,
  StoreBot,
} from '../database/schema';
import {TelegramSenderService} from './telegram-sender.service';
import {TelegramNotifyService} from './telegram-notify.service';
import {UpdateTelegramNotificationSettingsDto} from './dto/update-telegram-notification-settings.dto';
import {UpdateStoreBotDto} from './dto/update-store-bot.dto';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// xlsx uploads sometimes arrive with a generic mimetype; accept those only when
// the filename ends with .xlsx.
const FALLBACK_MIMES = ['application/octet-stream', 'application/zip'];

// Telegram notifications ship with Standart (`basic`) and up — cheap to run and
// good for retention, so they are not held back for the higher tiers. Only
// linking/configuration is gated: deliveries for an already-linked business keep
// flowing through TelegramNotifyService regardless of tier.
@ApiTags('telegram')
@Controller('telegram')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class TelegramController {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly sender: TelegramSenderService,
    private readonly notify: TelegramNotifyService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Get('notification-settings')
  @ApiOperation({
    summary: 'Which bot notifications the business has enabled',
  })
  async getNotificationSettings(@CurrentBusiness() business: IBusiness) {
    const s = await this.notify.getSettings(business.id);
    return {
      checkout: s.checkout,
      cashShifts: s.cashShifts,
      cashOperations: s.cashOperations,
      dailySales: s.dailySales,
    };
  }

  @Put('notification-settings')
  @ApiOperation({summary: 'Toggle which bot notifications get sent'})
  async updateNotificationSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateTelegramNotificationSettingsDto,
  ) {
    const s = await this.notify.updateSettings(business.id, dto);
    return {
      checkout: s.checkout,
      cashShifts: s.cashShifts,
      cashOperations: s.cashOperations,
      dailySales: s.dailySales,
    };
  }

  // ── Store bot (Telegram Mini App storefront) ───────────────────────────────
  // Pro-gated like the storefront itself, unlike the owner notifications above.

  @Get('store-bot')
  @MinTier('pro')
  @ApiOperation({
    summary: "The shop's own customer-facing bot for the mini-app storefront",
  })
  async getStoreBot(@CurrentBusiness() business: IBusiness) {
    const [row] = await this.db
      .select()
      .from(storeBots)
      .where(eq(storeBots.businessId, business.id))
      .limit(1);
    return this.toStoreBotApi(business, row ?? null);
  }

  @Put('store-bot')
  @MinTier('pro')
  @ApiOperation({
    summary: "Connect or disconnect the shop's own storefront bot",
  })
  async updateStoreBot(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateStoreBotDto,
  ) {
    const token = dto.botToken?.trim();

    // Empty or null disconnects: the storefront falls back to the platform bot.
    if (!token) {
      await this.db
        .delete(storeBots)
        .where(eq(storeBots.businessId, business.id));
      return this.toStoreBotApi(business, null);
    }

    // getMe is the only way to tell a real token from a typo, and it hands us
    // the @username the shop needs for its customer link.
    const me = await this.sender.getMe(token);
    if (!me) {
      throw new AppException(ErrorCode.TELEGRAM_BOT_TOKEN_INVALID);
    }

    const [row] = await this.db
      .insert(storeBots)
      .values({
        businessId: business.id,
        botToken: token,
        botUsername: me.username ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: storeBots.businessId,
        set: {
          botToken: token,
          botUsername: me.username ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return this.toStoreBotApi(business, row);
  }

  /**
   * Public shape of a store bot — never the token itself, only what the owner
   * needs to finish the BotFather setup.
   */
  private toStoreBotApi(business: IBusiness, row: StoreBot | null) {
    const slug = business.storeSlug ?? null;
    const rootDomain = process.env.STORE_ROOT_DOMAIN || 'kpos.uz';
    return {
      connected: !!row,
      botUsername: row?.botUsername ?? null,
      botLink: row?.botUsername ? `https://t.me/${row.botUsername}` : null,
      // The URL the owner pastes into BotFather (Menu Button / Mini App URL).
      miniAppUrl: slug ? `https://${slug}.${rootDomain}` : null,
      updatedAt: row?.updatedAt ?? null,
    };
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

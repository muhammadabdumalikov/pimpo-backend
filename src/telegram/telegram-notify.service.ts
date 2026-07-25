import {Inject, Injectable, Logger} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  telegramLinks,
  telegramNotificationSettings,
  TelegramNotificationSettings,
  CashShift,
  CashMovement,
} from '../database/schema';
import {CacheKeys, TTL} from '../cache/cache.util';
import {TelegramSenderService} from './telegram-sender.service';

/** The togglable notification events. Matches the boolean columns of the table. */
export type TelegramEvent =
  | 'checkout'
  | 'cashShifts'
  | 'cashOperations'
  | 'dailySales';

/** Only the sale fields a checkout notification needs (a subset of the order). */
export interface CheckoutNotice {
  totalAmount: string | number;
  itemCount?: number | null;
  paymentMethod?: string | null;
  cashierName?: string | null;
  createdAt?: Date | null;
}

/** Defaults for a business that has never saved settings: daily digest ON
 *  (it shipped before this toggle existed), everything else opt-in / OFF. */
function defaultSettings(businessId: string): TelegramNotificationSettings {
  return {
    businessId,
    checkout: false,
    cashShifts: false,
    cashOperations: false,
    dailySales: true,
    updatedAt: new Date(),
  };
}

const uz = (n: number | string) =>
  new Intl.NumberFormat('uz-UZ').format(Math.round(Number(n) || 0));

/** HH:MM in the business zone (+05:00 Asia/Tashkent), matching digest.service. */
function hhmm(date?: Date | null): string {
  const ms = (date ? date.getTime() : Date.now()) + 5 * 3_600_000;
  return new Date(ms).toISOString().slice(11, 16);
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Naqd',
  card: 'Karta',
  transfer: "O'tkazma",
  debt: 'Nasiya',
  split: 'Aralash',
  bonus: 'Bonus',
};
const paymentLabel = (m?: string | null) =>
  (m && PAYMENT_LABELS[m]) || m || '—';

/**
 * Delivers per-event Telegram notifications to a business's linked chats.
 *
 * Reuses the same primitives as the digest: the login-gated `telegram_links`
 * (active chats for the business) + `TelegramSenderService.sendMessage`. Every
 * event is gated by the business's `telegram_notification_settings` row (cached,
 * write-invalidated on the settings PUT).
 *
 * The `notify*` helpers are FIRE-AND-FORGET: they never throw and never block
 * the caller (checkout / shift close must not wait on Telegram HTTP). Delivery
 * failures are swallowed + logged. The digest cron instead awaits
 * `broadcastIfEnabled` directly since it isn't latency-sensitive.
 */
@Injectable()
export class TelegramNotifyService {
  private readonly logger = new Logger(TelegramNotifyService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly sender: TelegramSenderService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ── Settings (cached) ──────────────────────────────────────────────────────

  /** The business's toggles; the defaults (dailySales on) when no row exists. */
  async getSettings(businessId: string): Promise<TelegramNotificationSettings> {
    return this.cache.wrap(
      CacheKeys.telegramSettings(businessId),
      async () => {
        try {
          const [row] = await this.db
            .select()
            .from(telegramNotificationSettings)
            .where(eq(telegramNotificationSettings.businessId, businessId))
            .limit(1);
          return row ?? defaultSettings(businessId);
        } catch (e) {
          // Fail open to defaults if the table isn't migrated yet (or the DB is
          // momentarily unreachable) — the settings page must not 500 and event
          // delivery must not throw. Mirrors the stock-take-lock fallback.
          this.logger.warn(
            `telegram settings read failed → defaults: ${(e as Error).message}`,
          );
          return defaultSettings(businessId);
        }
      },
      TTL.TELEGRAM_SETTINGS,
    );
  }

  /** Upsert the toggles (only provided keys change) and drop the cache. */
  async updateSettings(
    businessId: string,
    patch: Partial<Pick<TelegramNotificationSettings, TelegramEvent>>,
  ): Promise<TelegramNotificationSettings> {
    const now = new Date();
    const [row] = await this.db
      .insert(telegramNotificationSettings)
      .values({businessId, ...patch, updatedAt: now})
      .onConflictDoUpdate({
        target: telegramNotificationSettings.businessId,
        set: {...patch, updatedAt: now},
      })
      .returning();
    await this.cache.del(CacheKeys.telegramSettings(businessId));
    return row;
  }

  // ── Delivery ───────────────────────────────────────────────────────────────

  /** Send `message` to every active chat IF `event` is enabled + bot configured. */
  async broadcastIfEnabled(
    businessId: string,
    event: TelegramEvent,
    message: string,
  ): Promise<void> {
    if (!this.sender.isConfigured()) return;
    const settings = await this.getSettings(businessId);
    if (!settings[event]) return;

    const links = await this.db
      .select({chatId: telegramLinks.chatId})
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.businessId, businessId),
          eq(telegramLinks.isActive, true),
        ),
      );
    for (const link of links) {
      try {
        await this.sender.sendMessage(link.chatId, message);
      } catch (e) {
        this.logger.warn(
          `notify ${event} → chat ${link.chatId} failed: ${(e as Error).message}`,
        );
      }
    }
  }

  /** Fire-and-forget: build+deliver in the background; never throw/block. */
  private fire(businessId: string, event: TelegramEvent, message: string): void {
    void this.broadcastIfEnabled(businessId, event, message).catch((e) =>
      this.logger.warn(`notify ${event} error: ${(e as Error).message}`),
    );
  }

  // ── Typed event helpers (called from the hot paths) ─────────────────────────

  notifyCheckout(businessId: string, o: CheckoutNotice): void {
    const lines = [
      '🧾 Yangi sotuv',
      `💰 Summa: ${uz(o.totalAmount)} so'm`,
      `💳 To'lov: ${paymentLabel(o.paymentMethod)}`,
    ];
    if (o.itemCount != null) lines.push(`📦 Mahsulot: ${uz(o.itemCount)} ta`);
    if (o.cashierName) lines.push(`👤 Kassir: ${o.cashierName}`);
    lines.push(`🕒 ${hhmm(o.createdAt)}`);
    this.fire(businessId, 'checkout', lines.join('\n'));
  }

  notifyShiftOpened(businessId: string, shift: CashShift): void {
    const lines = [
      '🟢 Smena ochildi',
      `🏦 Kassa: ${shift.registerName}`,
      `💵 Boshlang'ich: ${uz(shift.openingFloat ?? 0)} so'm`,
    ];
    if (shift.openedByCashierName)
      lines.push(`👤 Kassir: ${shift.openedByCashierName}`);
    lines.push(`🕒 ${hhmm(shift.openedAt)}`);
    this.fire(businessId, 'cashShifts', lines.join('\n'));
  }

  notifyShiftClosed(
    businessId: string,
    shift: CashShift,
    sales: {cashSales: number; cardSales: number},
  ): void {
    const lines = [
      '🔴 Smena yopildi',
      `🏦 Kassa: ${shift.registerName}`,
      `🧾 Cheklar: ${uz(shift.orderCount ?? 0)} ta`,
      `💰 Naqd savdo: ${uz(sales.cashSales)} so'm`,
      `💳 Karta savdo: ${uz(sales.cardSales)} so'm`,
    ];
    if (shift.countedCash != null)
      lines.push(`🧮 Sanaldi (naqd): ${uz(shift.countedCash)} so'm`);
    if (shift.expectedCash != null)
      lines.push(`📊 Kutilgan (naqd): ${uz(shift.expectedCash)} so'm`);
    const diff = shift.difference != null ? Number(shift.difference) : null;
    if (diff != null && diff < 0)
      lines.push(`⚠️ Kamomad: ${uz(Math.abs(diff))} so'm`);
    else if (diff != null && diff > 0)
      lines.push(`✅ Ortiqcha: ${uz(diff)} so'm`);
    else if (diff === 0) lines.push('✅ Kassa mos keldi');
    if (shift.closedByCashierName)
      lines.push(`👤 Kassir: ${shift.closedByCashierName}`);
    this.fire(businessId, 'cashShifts', lines.join('\n'));
  }

  notifyCashOperation(businessId: string, m: CashMovement): void {
    const isIn = m.type === 'in';
    const cur = m.currency && m.currency !== 'UZS' ? ` ${m.currency}` : " so'm";
    const lines = [
      isIn ? '💵 Kassa kirim' : '💸 Kassa chiqim',
      `💰 Summa: ${uz(m.amount)}${cur}`,
    ];
    if (m.categoryName) lines.push(`🏷 Kategoriya: ${m.categoryName}`);
    if (m.reason) lines.push(`📝 Izoh: ${m.reason}`);
    if (m.cashierName) lines.push(`👤 Kassir: ${m.cashierName}`);
    lines.push(`🕒 ${hhmm(m.createdAt)}`);
    this.fire(businessId, 'cashOperations', lines.join('\n'));
  }
}

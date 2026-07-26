import {Inject, Injectable, Logger, Optional} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {InjectQueue} from '@nestjs/bullmq';
import {Queue} from 'bullmq';
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
import {TELEGRAM_QUEUE, TelegramJobData} from './telegram.constants';

/** The togglable notification events. Matches the boolean columns of the table. */
export type TelegramEvent =
  | 'checkout'
  | 'cashShifts'
  | 'cashOperations'
  | 'dailySales';

/** One line of a checkout notice (a sold product). */
export interface CheckoutNoticeItem {
  name: string;
  quantity: number;
  priceOut: string | number;
  lineTotal: string | number;
}

/** The sale fields a (detailed) checkout notification needs. */
export interface CheckoutNotice {
  totalAmount: string | number;
  subtotalAmount?: string | number | null;
  discountAmount?: string | number | null;
  loyaltyRedeemed?: string | number | null;
  taxAmount?: string | number | null;
  itemCount?: number | null;
  paymentMethod?: string | null;
  // Per-method breakdown when the customer split the payment (or single-method).
  payments?: {method: string; amount: number}[] | null;
  amountPaid?: string | number | null;
  changeAmount?: string | number | null;
  customerName?: string | null;
  cashierName?: string | null;
  createdAt?: Date | null;
  items?: CheckoutNoticeItem[];
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

// Money — rounded so'm (no tiyin in practice). Nullable input coerces to 0.
const uz = (n: number | string | null | undefined) =>
  new Intl.NumberFormat('uz-UZ').format(Math.round(Number(n) || 0));

// Quantity — keep decimals for weighted goods (e.g. 1.5 kg).
const qty = (n: number | string | null | undefined) =>
  new Intl.NumberFormat('uz-UZ', {maximumFractionDigits: 3}).format(
    Number(n) || 0,
  );

/** HH:MM in the business zone (+05:00 Asia/Tashkent), matching digest.service. */
function hhmm(date?: Date | null): string {
  const ms = (date ? date.getTime() : Date.now()) + 5 * 3_600_000;
  return new Date(ms).toISOString().slice(11, 16);
}

/** DD.MM.YYYY HH:MM in the business zone (+05:00). */
function dateTime(date?: Date | null): string {
  const ms = (date ? date.getTime() : Date.now()) + 5 * 3_600_000;
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:...
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y} ${iso.slice(11, 16)}`;
}

// Cap the product list so a huge cart can't blow past Telegram's 4096-char limit.
const MAX_ITEM_LINES = 40;

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
 * the caller (checkout / shift close must not wait on Telegram HTTP). When Redis
 * is configured, `dispatch` ENQUEUES the pre-rendered message onto the BullMQ
 * `telegram-notifications` queue (retries + rate limiting handled by the
 * processor); otherwise it falls back to a best-effort direct `broadcast`.
 */
@Injectable()
export class TelegramNotifyService {
  private readonly logger = new Logger(TelegramNotifyService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly sender: TelegramSenderService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    // Absent when Redis isn't configured (queue not registered) → direct send.
    @Optional()
    @InjectQueue(TELEGRAM_QUEUE)
    private readonly queue?: Queue<TelegramJobData>,
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

  /** Active chat ids linked to the business (login-gated bot links). */
  async listActiveChatIds(businessId: string): Promise<string[]> {
    const links = await this.db
      .select({chatId: telegramLinks.chatId})
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.businessId, businessId),
          eq(telegramLinks.isActive, true),
        ),
      );
    return links.map((l) => l.chatId);
  }

  /**
   * Gate on settings + bot config, then hand the message to the queue (retries +
   * rate limiting) — or, when no queue is registered (no Redis), send it directly
   * best-effort. Awaitable so the digest can enqueue-then-continue; the hot paths
   * call it fire-and-forget via the `notify*` helpers.
   */
  async dispatch(
    businessId: string,
    event: TelegramEvent,
    message: string,
  ): Promise<void> {
    if (!this.sender.isConfigured()) return;
    const settings = await this.getSettings(businessId);
    if (!settings[event]) return;

    if (this.queue) {
      await this.queue.add(event, {businessId, event, message});
    } else {
      await this.broadcast(businessId, message);
    }
  }

  /** Best-effort direct send to every active chat (queue fallback). */
  async broadcast(businessId: string, message: string): Promise<void> {
    if (!this.sender.isConfigured()) return;
    for (const chatId of await this.listActiveChatIds(businessId)) {
      try {
        await this.sender.sendMessage(chatId, message);
      } catch (e) {
        this.logger.warn(
          `notify → chat ${chatId} failed: ${(e as Error).message}`,
        );
      }
    }
  }

  /** Fire-and-forget: gate+enqueue in the background; never throw/block. */
  private fire(businessId: string, event: TelegramEvent, message: string): void {
    void this.dispatch(businessId, event, message).catch((e) =>
      this.logger.warn(`notify ${event} error: ${(e as Error).message}`),
    );
  }

  // ── Typed event helpers (called from the hot paths) ─────────────────────────

  notifyCheckout(businessId: string, o: CheckoutNotice): void {
    const lines: string[] = [`🧾 Yangi sotuv — ${dateTime(o.createdAt)}`];

    // Product lines: "1. Name — 2 × 8 000 = 16 000 so'm" (capped for long carts).
    const items = o.items ?? [];
    if (items.length > 0) {
      lines.push('', '🛒 Mahsulotlar:');
      items.slice(0, MAX_ITEM_LINES).forEach((it, i) => {
        lines.push(
          `${i + 1}. ${it.name} — ${qty(it.quantity)} × ${uz(it.priceOut)} = ${uz(
            it.lineTotal,
          )} so'm`,
        );
      });
      if (items.length > MAX_ITEM_LINES) {
        lines.push(`… va yana ${items.length - MAX_ITEM_LINES} ta mahsulot`);
      }
    }

    // Totals block. Show the intermediate rows only when they carry a value, so
    // a plain no-discount sale stays compact.
    lines.push('');
    if (o.itemCount != null) lines.push(`📦 Jami: ${qty(o.itemCount)} dona`);
    const num = (v: unknown) => Number(v) || 0;
    if (o.subtotalAmount != null && num(o.subtotalAmount) !== num(o.totalAmount))
      lines.push(`🧾 Oraliq: ${uz(o.subtotalAmount)} so'm`);
    if (num(o.discountAmount) > 0)
      lines.push(`🏷 Chegirma: −${uz(o.discountAmount)} so'm`);
    if (num(o.loyaltyRedeemed) > 0)
      lines.push(`🎁 Bonus: −${uz(o.loyaltyRedeemed)} so'm`);
    if (num(o.taxAmount) > 0) lines.push(`＋ QQS: ${uz(o.taxAmount)} so'm`);
    lines.push(`💰 Jami: ${uz(o.totalAmount)} so'm`);

    // Payment details.
    const payments = (o.payments ?? []).filter((p) => p && p.method);
    const paidNow = payments.reduce((s, p) => s + num(p.amount), 0);
    lines.push('');
    if (o.paymentMethod === 'debt') {
      // Nasiya: down payment (if any) up front, remainder owed. The remainder is
      // total − bonus − what was paid now (matches order.service's debtAmount).
      const debt = Math.max(
        0,
        num(o.totalAmount) - num(o.loyaltyRedeemed) - paidNow,
      );
      lines.push("💳 To'lov: Nasiya");
      payments.forEach((p) =>
        lines.push(`  • ${paymentLabel(p.method)}: ${uz(p.amount)} so'm`),
      );
      if (paidNow > 0) lines.push(`💵 To'landi: ${uz(paidNow)} so'm`);
      lines.push(`🔴 Qarz: ${uz(debt)} so'm`);
    } else {
      // Per-method breakdown if split, else the single method.
      if (payments.length > 1) {
        lines.push("💳 To'lov:");
        payments.forEach((p) =>
          lines.push(`  • ${paymentLabel(p.method)}: ${uz(p.amount)} so'm`),
        );
      } else {
        const method = payments[0]?.method ?? o.paymentMethod;
        lines.push(`💳 To'lov: ${paymentLabel(method)}`);
      }
      if (num(o.amountPaid) > 0)
        lines.push(`💵 Berildi: ${uz(o.amountPaid)} so'm`);
      if (num(o.changeAmount) > 0)
        lines.push(`🔁 Qaytim: ${uz(o.changeAmount)} so'm`);
    }

    if (o.customerName) lines.push('', `🙍 Mijoz: ${o.customerName}`);
    if (o.cashierName) lines.push(`👤 Kassir: ${o.cashierName}`);

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

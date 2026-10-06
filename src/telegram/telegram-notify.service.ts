import {Inject, Injectable, Logger, Optional} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {InjectQueue} from '@nestjs/bullmq';
import {Queue} from 'bullmq';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  businesses,
  storeBots,
  telegramLinks,
  telegramNotificationSettings,
  TelegramNotificationSettings,
  CashShift,
  CashMovement,
} from '../database/schema';
import {CacheKeys} from '../cache/cache.util';
import {TelegramSenderService} from './telegram-sender.service';
import {TELEGRAM_QUEUE, TelegramJobData} from './telegram.constants';
import {NotifyToggle, readNotificationSettings} from './notification-settings';
import {NotificationService} from '../notification/notification.service';
import {Notice} from '../notification/push-text';

/**
 * The togglable events that also go to Telegram. `announcements` is the one
 * toggle with no Telegram counterpart (phone push only).
 */
export type TelegramEvent = Exclude<NotifyToggle, 'announcements'>;

/** One line of a checkout notice (a sold product). */
export interface CheckoutNoticeItem {
  name: string;
  quantity: number;
  priceOut: string | number;
  lineTotal: string | number;
}

/** The sale fields a (detailed) checkout notification needs. */
export interface CheckoutNotice {
  orderId?: string;
  receiptNo?: number | null;
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

// Customer-facing headlines for an online order's status. Wording matches the
// storefront's own status labels (Uzbek — the storefront's default locale).
const STORE_STATUS_HEADLINES: Record<string, string> = {
  Confirmed: '✅ Buyurtmangiz qabul qilindi',
  Completed: '📦 Buyurtmangiz topshirildi. Xaridingiz uchun rahmat!',
  Cancelled: '❌ Buyurtmangiz rad etildi',
};

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
    private readonly notifications: NotificationService,
    // Absent when Redis isn't configured (queue not registered) → direct send.
    @Optional()
    @InjectQueue(TELEGRAM_QUEUE)
    private readonly queue?: Queue<TelegramJobData>,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ── Settings (cached) ──────────────────────────────────────────────────────

  /** The business's toggles (shared with phone push); defaults when no row exists. */
  async getSettings(businessId: string): Promise<TelegramNotificationSettings> {
    return readNotificationSettings(this.dbService, this.cache, businessId);
  }

  /** Upsert the toggles (only provided keys change) and drop the cache. */
  async updateSettings(
    businessId: string,
    patch: Partial<Pick<TelegramNotificationSettings, NotifyToggle>>,
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
   * Gate on the shared toggle, hand `notice` to the owner's inbox + phone push,
   * then — if a bot is configured — the message to the queue (retries + rate
   * limiting), or, with no queue registered (no Redis), send it directly
   * best-effort. Awaitable so the digest can enqueue-then-continue; the hot
   * paths call it fire-and-forget via the `notify*` helpers.
   */
  async dispatch(
    businessId: string,
    event: TelegramEvent,
    message: string,
    notice?: Notice,
  ): Promise<void> {
    const settings = await this.getSettings(businessId);
    if (!settings[event]) return;
    if (notice) this.notifications.fire(businessId, notice);
    if (!this.sender.isConfigured()) return;

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
  private fire(
    businessId: string,
    event: TelegramEvent,
    message: string,
    notice?: Notice,
  ): void {
    void this.dispatch(businessId, event, message, notice).catch((e) =>
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

    this.fire(businessId, 'checkout', lines.join('\n'), {
      event: 'checkout',
      data: {
        orderId: o.orderId ?? null,
        receiptNo: o.receiptNo ?? null,
        total: Number(o.totalAmount) || 0,
        cashierName: o.cashierName ?? null,
        url: o.orderId ? `/sales?sale=${o.orderId}` : '/sales',
      },
    });
  }

  /**
   * DM a storefront customer that their online order moved on.
   *
   * Different audience from every other helper here: the recipient is the
   * shopper's own chat (their Telegram user id, captured at mini-app checkout),
   * not the business's linked chats — so it bypasses both the per-business
   * settings gate and the broadcast queue. It also sends from the shop's own
   * store bot (the one that opened the mini app), not the platform bot: a
   * customer can only be messaged by a bot they have started.
   *
   * Best-effort and non-blocking: a customer who never pressed Start simply
   * cannot be reached, and that must never fail the shop's status update.
   */
  notifyStoreOrderStatus(
    businessId: string,
    o: {
      telegramUserId: string;
      orderId: string;
      status: string;
      totalAmount: string | number;
      itemCount?: number | null;
    },
  ): void {
    const headline = STORE_STATUS_HEADLINES[o.status];
    // Only the transitions the shopper cares about; 'Pending' is the state they
    // already saw at checkout.
    if (!headline) return;

    void (async () => {
      // The shop's own store bot, else the platform bot (single-bot setups).
      const [row] = await this.db
        .select({name: businesses.name, botToken: storeBots.botToken})
        .from(businesses)
        .leftJoin(storeBots, eq(storeBots.businessId, businesses.id))
        .where(eq(businesses.id, businessId))
        .limit(1);
      const token = row?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
      if (!token) return;

      const lines = [headline, ''];
      lines.push(`🧾 Buyurtma: #${o.orderId.slice(0, 8).toUpperCase()}`);
      if (o.itemCount != null) lines.push(`📦 Jami: ${qty(o.itemCount)} dona`);
      lines.push(`💰 Summa: ${uz(o.totalAmount)} so'm`);
      if (row?.name) lines.push('', `🏪 ${row.name}`);

      // A private chat's id is the user's own id.
      await this.sender.sendMessage(o.telegramUserId, lines.join('\n'), token);
    })().catch((e) =>
      this.logger.warn(
        `store order status DM failed (user ${o.telegramUserId}): ${
          (e as Error).message
        }`,
      ),
    );
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
    this.fire(businessId, 'cashShifts', lines.join('\n'), {
      event: 'shiftOpened',
      data: {
        shiftId: shift.id,
        registerName: shift.registerName,
        cashierName: shift.openedByCashierName ?? null,
        openingFloat: Number(shift.openingFloat ?? 0),
        url: '/money',
      },
    });
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
    this.fire(businessId, 'cashShifts', lines.join('\n'), {
      event: 'shiftClosed',
      data: {
        shiftId: shift.id,
        registerName: shift.registerName,
        cashierName: shift.closedByCashierName ?? null,
        expected: shift.expectedCash != null ? Number(shift.expectedCash) : null,
        counted: shift.countedCash != null ? Number(shift.countedCash) : null,
        diff,
        url: '/money',
      },
    });
  }

  notifyCashOperation(businessId: string, m: CashMovement): void {
    const isIn = m.type === 'in';
    const cur = m.currency && m.currency !== 'UZS' ? ` ${m.currency}` : " so'm";
    const lines = [
      isIn ? '💵 Kassa kirim' : '💸 Kassa chiqim',
      `💰 Summa: ${uz(m.amount)}${cur}`,
    ];
    if (m.categoryName) lines.push(`🏷 Kategoriya: ${m.categoryName}`);
    if (m.supplierName) lines.push(`🚚 Yetkazib beruvchi: ${m.supplierName}`);
    if (m.reason) lines.push(`📝 Izoh: ${m.reason}`);
    if (m.cashierName) lines.push(`👤 Kassir: ${m.cashierName}`);
    lines.push(`🕒 ${hhmm(m.createdAt)}`);
    this.fire(businessId, 'cashOperations', lines.join('\n'), {
      event: 'cashOperation',
      data: {
        shiftId: m.shiftId ?? null,
        direction: isIn ? 'in' : 'out',
        amount: Number(m.amount) || 0,
        currency: m.currency || 'UZS',
        note: m.reason || m.categoryName || m.supplierName || null,
        cashierName: m.cashierName ?? null,
        url: '/kassa/operations',
      },
    });
  }

  // ── Owner phone events (MOBILE.md Q9) — also sent to Telegram ──────────────

  /** A storefront order arrived and waits for the shop to confirm it. */
  notifyOnlineOrder(
    businessId: string,
    o: {
      orderId: string;
      totalAmount: string | number;
      itemCount?: number | null;
      customerName?: string | null;
      customerPhone?: string | null;
    },
  ): void {
    const lines = [
      '🛒 Yangi onlayn buyurtma',
      `🧾 #${o.orderId.slice(0, 8).toUpperCase()}`,
      `💰 Summa: ${uz(o.totalAmount)} so'm`,
    ];
    if (o.itemCount != null) lines.push(`📦 ${qty(o.itemCount)} dona`);
    if (o.customerName) lines.push(`🙍 Mijoz: ${o.customerName}`);
    if (o.customerPhone) lines.push(`📞 ${o.customerPhone}`);
    this.fire(businessId, 'onlineOrders', lines.join('\n'), {
      event: 'onlineOrder',
      data: {
        orderId: o.orderId,
        total: Number(o.totalAmount) || 0,
        itemCount: o.itemCount ?? null,
        customerName: o.customerName ?? null,
        url: `/sales?tab=online&order=${o.orderId}`,
      },
    });
  }

  /** Staff cancelled a till receipt (the owner's own actions are not reported). */
  notifyOrderCancelled(
    businessId: string,
    o: {orderId: string; receiptNo?: number | null; totalAmount: string | number; by?: string | null},
  ): void {
    const lines = [
      '🚩 Chek bekor qilindi',
      ...(o.receiptNo != null ? [`🧾 Chek #${o.receiptNo}`] : []),
      `💰 Summa: ${uz(o.totalAmount)} so'm`,
      ...(o.by ? [`👤 ${o.by}`] : []),
    ];
    this.fire(businessId, 'suspicious', lines.join('\n'), {
      event: 'orderCancelled',
      data: {
        orderId: o.orderId,
        receiptNo: o.receiptNo ?? null,
        total: Number(o.totalAmount) || 0,
        by: o.by ?? null,
        url: `/sales?sale=${o.orderId}`,
      },
    });
  }

  /** Staff rang up a receipt with a whole-receipt discount over the threshold. */
  notifyBigDiscount(
    businessId: string,
    o: {
      orderId: string;
      receiptNo?: number | null;
      subtotal: number;
      discount: number;
      total: number;
      by?: string | null;
    },
  ): void {
    const pct = o.subtotal > 0 ? (o.discount / o.subtotal) * 100 : 0;
    const lines = [
      `🚩 Katta chegirma — ${Math.round(pct)}%`,
      ...(o.receiptNo != null ? [`🧾 Chek #${o.receiptNo}`] : []),
      `🏷 Chegirma: −${uz(o.discount)} so'm`,
      `💰 Jami: ${uz(o.total)} so'm`,
      ...(o.by ? [`👤 ${o.by}`] : []),
    ];
    this.fire(businessId, 'suspicious', lines.join('\n'), {
      event: 'bigDiscount',
      data: {
        orderId: o.orderId,
        receiptNo: o.receiptNo ?? null,
        subtotal: o.subtotal,
        discount: o.discount,
        total: o.total,
        pct,
        by: o.by ?? null,
        url: `/sales?sale=${o.orderId}`,
      },
    });
  }

  /** Staff took a customer return. */
  notifySaleReturn(
    businessId: string,
    r: {
      returnId: string;
      orderId?: string | null;
      receiptNo?: number | null;
      totalAmount: string | number;
      by?: string | null;
    },
  ): void {
    const lines = [
      '🚩 Qaytarish',
      ...(r.receiptNo != null ? [`🧾 Chek #${r.receiptNo}`] : []),
      `💰 Summa: ${uz(r.totalAmount)} so'm`,
      ...(r.by ? [`👤 ${r.by}`] : []),
    ];
    this.fire(businessId, 'suspicious', lines.join('\n'), {
      event: 'saleReturn',
      data: {
        returnId: r.returnId,
        orderId: r.orderId ?? null,
        receiptNo: r.receiptNo ?? null,
        total: Number(r.totalAmount) || 0,
        by: r.by ?? null,
        url: '/sales?tab=returns',
      },
    });
  }

  /**
   * Waiting lower prices took effect by themselves — the stock received
   * before their delivery sold out — so the shelf labels now show the old
   * figure. Retail tier only in the message; the other tiers move silently.
   */
  notifyPriceChanges(
    businessId: string,
    changes: {
      productId: string;
      productName: string;
      field: string;
      from: string | null;
      to: string;
    }[],
  ): void {
    const retail = changes.filter((c) => c.field === 'priceOut');
    if (retail.length === 0) return;
    const shown = retail.slice(0, 15);
    const lines = [
      retail.length > 1
        ? `🏷 Narx tushdi — ${retail.length} ta tovar`
        : '🏷 Narx tushdi',
      ...shown.map(
        (c) =>
          `• ${c.productName}: ${c.from != null ? `${uz(c.from)} → ` : ''}${uz(c.to)} so'm`,
      ),
      ...(retail.length > shown.length
        ? [`… va yana ${retail.length - shown.length} ta`]
        : []),
      '',
      'Eski qoldiq tugadi. Etiketkani almashtiring.',
    ];
    const one = retail[0];
    this.fire(businessId, 'priceChanges', lines.join('\n'), {
      event: 'priceChanged',
      data: {
        count: retail.length,
        name: one.productName,
        from: one.from != null ? Number(one.from) : null,
        to: Number(one.to),
        names: shown.map((c) => c.productName),
        url:
          retail.length > 1
            ? '/products?priceChanged=today'
            : `/products/${one.productId}/price-history`,
      },
    });
  }
}

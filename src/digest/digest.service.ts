import {Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {DatabaseService} from '../database/database.service';
import {
  businesses,
  orders,
  orderItems,
  cashShifts,
  saleReturns,
  products,
  telegramNotificationSettings,
} from '../database/schema';
import {eq, and, gte, lt, lte, sql, desc, isNull, or} from 'drizzle-orm';
import {businessDayStart, businessDayEnd} from '../common/business-time';
import {TelegramNotifyService} from '../telegram/telegram-notify.service';
import {ProductService} from '../product/product.service';
import {
  DIGEST_DEFAULTS,
  digestWindow,
  dueSlot,
  localParts,
} from './digest-schedule';

export interface DailyDigest {
  date: string; // YYYY-MM-DD (business zone) the window starts on
  /** Business-zone 'HH:MM' bounds of the window; to is exclusive. */
  from: string;
  to: string;
  /** Window crosses midnight / spans days — the message then names both dates. */
  endDate: string;
  revenue: number;
  orderCount: number;
  avgCheck: number;
  units: number;
  /** Customer returns handed back that day (already netted off revenue). */
  returns: number;
  cashDifference: number; // negative = shortage across shifts closed that day
  topProducts: {name: string; qty: number; revenue: number}[];
}

/**
 * Daily owner digest (R30). Each shop picks when it is sent and which hours it
 * covers (telegram_notification_settings.daily_sales_*; default 21:00, the day
 * so far). A once-a-minute tick sends every slot that came due — see
 * digest-schedule.ts for the window rules.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly telegramNotify: TelegramNotifyService,
    private readonly productService: ProductService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** Today's date (YYYY-MM-DD) in the business zone (+05:00). */
  private todayYmd(): string {
    return new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
  }

  /** A whole business-zone calendar day (the preview endpoint). */
  async buildDigest(businessId: string, date?: string): Promise<DailyDigest> {
    const ymd = /^\d{4}-\d{2}-\d{2}/.test(date ?? '')
      ? (date as string).slice(0, 10)
      : this.todayYmd();
    return this.buildDigestRange(
      businessId,
      businessDayStart(ymd),
      new Date(businessDayEnd(ymd).getTime() + 1),
    );
  }

  /** Sales in [start, end) — end exclusive. */
  async buildDigestRange(
    businessId: string,
    start: Date,
    end: Date,
  ): Promise<DailyDigest> {
    const from = localParts(start);
    const to = localParts(end);

    const dayWhere = and(
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
      gte(orders.createdAt, start),
      lt(orders.createdAt, end),
    );

    const [sales] = await this.db
      .select({
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        orderCount: sql<string>`COUNT(*)`,
        units: sql<string>`COALESCE(SUM(${orders.itemCount}), 0)`,
      })
      .from(orders)
      .where(dayWhere);
    // Customer returns handed back that day net off the day's takings.
    const [ret] = await this.db
      .select({
        value: sql<string>`COALESCE(SUM(${saleReturns.totalAmount}), 0)`,
        units: sql<string>`COALESCE(SUM(${saleReturns.itemCount}), 0)`,
      })
      .from(saleReturns)
      .where(
        and(
          eq(saleReturns.businessId, businessId),
          gte(saleReturns.createdAt, start),
          lt(saleReturns.createdAt, end),
        ),
      );
    const returns = Number(ret?.value ?? 0);
    const revenue = Number(sales?.revenue ?? 0) - returns;
    const orderCount = Number(sales?.orderCount ?? 0);

    // Kassa reconciliation across shifts closed that day (negative = shortage).
    const [diffRow] = await this.db
      .select({
        difference: sql<string>`COALESCE(SUM(${cashShifts.difference}), 0)`,
      })
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.businessId, businessId),
          eq(cashShifts.status, 'closed'),
          gte(cashShifts.closedAt, start),
          lt(cashShifts.closedAt, end),
        ),
      );

    const topRows = await this.db
      .select({
        name: orderItems.productName,
        qty: sql<string>`COALESCE(SUM(${orderItems.quantity}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${orderItems.lineTotal}), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(dayWhere)
      .groupBy(orderItems.productName)
      .orderBy(desc(sql`SUM(${orderItems.lineTotal})`))
      .limit(5);

    return {
      date: from.ymd,
      from: from.hm,
      to: to.hm,
      endDate: to.ymd,
      revenue,
      orderCount,
      avgCheck: orderCount > 0 ? revenue / orderCount : 0,
      units: Number(sales?.units ?? 0) - Number(ret?.units ?? 0),
      returns,
      cashDifference: Number(diffRow?.difference ?? 0),
      topProducts: topRows.map((r) => ({
        name: r.name,
        qty: Number(r.qty),
        revenue: Number(r.revenue),
      })),
    };
  }

  /** Telegram-ready Uzbek message for a digest. */
  formatMessage(digest: DailyDigest, businessName?: string): string {
    const uz = (n: number) =>
      new Intl.NumberFormat('uz-UZ').format(Math.round(n));
    const lines: string[] = [];
    lines.push(`📊 Kunlik hisobot — ${digest.date}`);
    if (businessName) lines.push(`🏪 ${businessName}`);
    // A window ending at midnight reads "00:00–24:00", not "…–00:00 (next day)".
    const dm = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
    const endsAtMidnight =
      digest.to === '00:00' && digest.endDate !== digest.date;
    const sameDay = digest.endDate === digest.date || endsAtMidnight;
    lines.push(
      sameDay
        ? `🕘 ${digest.from} – ${endsAtMidnight ? '24:00' : digest.to}`
        : `🕘 ${dm(digest.date)} ${digest.from} – ${dm(digest.endDate)} ${digest.to}`,
    );
    lines.push('');
    lines.push(`💰 Tushum: ${uz(digest.revenue)} so'm`);
    lines.push(`🧾 Cheklar: ${uz(digest.orderCount)} ta`);
    if (digest.returns > 0) {
      lines.push(`↩️ Qaytarildi: ${uz(digest.returns)} so'm`);
    }
    lines.push(`🎯 O'rtacha chek: ${uz(digest.avgCheck)} so'm`);
    if (digest.cashDifference < 0) {
      lines.push(
        `⚠️ Kassa kamomad: ${uz(Math.abs(digest.cashDifference))} so'm`,
      );
    } else if (digest.cashDifference > 0) {
      lines.push(`✅ Kassa ortiqcha: ${uz(digest.cashDifference)} so'm`);
    }
    if (digest.topProducts.length > 0) {
      lines.push('');
      lines.push('🔝 TOP-5 tovar:');
      digest.topProducts.forEach((p, i) => {
        lines.push(
          `${i + 1}. ${p.name} — ${uz(p.qty)} × / ${uz(p.revenue)} so'm`,
        );
      });
    }
    return lines.join('\n');
  }

  private digestTickRunning = false;

  /**
   * Every minute: send each shop's digest whose slot came due (or was missed by
   * a restart within the catch-up window). The slot is claimed in the database
   * before sending, so it goes out once even with two containers rolling over.
   */
  @Cron('* * * * *', {name: 'daily-digest', timeZone: 'Asia/Tashkent'})
  async runDailyDigests(now: Date = new Date()): Promise<void> {
    if (process.env.DAILY_DIGEST === 'off') return;
    if (this.digestTickRunning) return;
    this.digestTickRunning = true;
    try {
      const s = telegramNotificationSettings;
      const rows = await this.db
        .select({
          id: businesses.id,
          name: businesses.name,
          sendAt: s.dailySalesSendAt,
          from: s.dailySalesFrom,
          to: s.dailySalesTo,
          lastSentAt: s.dailySalesLastSentAt,
        })
        .from(businesses)
        .leftJoin(s, eq(s.businessId, businesses.id))
        .where(
          and(
            eq(businesses.isActive, true),
            // No row = defaults, digest on.
            or(isNull(s.businessId), eq(s.dailySales, true)),
          ),
        );

      for (const b of rows) {
        const slot = dueSlot(
          now,
          b.sendAt ?? DIGEST_DEFAULTS.sendAt,
          b.lastSentAt,
        );
        if (!slot) continue;
        try {
          if (!(await this.claimSlot(b.id, slot))) continue;
          const {start, end} = digestWindow(
            slot,
            b.from ?? DIGEST_DEFAULTS.from,
            b.to ?? DIGEST_DEFAULTS.to,
          );
          const digest = await this.buildDigestRange(b.id, start, end);
          if (digest.orderCount === 0) continue; // no sales → no digest
          const message = this.formatMessage(digest, b.name);
          // Enqueue (or direct-send with no Redis); gated on the daily-sales
          // toggle. The queue rate-limits shops that share a send time.
          await this.telegramNotify.dispatch(b.id, 'dailySales', message, {
            event: 'dailySales',
            data: {
              date: digest.date,
              from: digest.from,
              to: digest.to,
              revenue: digest.revenue,
              orderCount: digest.orderCount,
              avgCheck: digest.avgCheck,
              profit: null,
              url: '/dashboard',
            },
          });
          this.logger.log(`Daily digest sent for ${b.name} (${b.id})`);
        } catch (e) {
          this.logger.error(
            `Digest failed for business ${b.id}: ${(e as Error).message}`,
          );
        }
      }
    } finally {
      this.digestTickRunning = false;
    }
  }

  /**
   * Mark `slot` handled for the shop; false when it already was (another
   * container, or an earlier tick). A shop with no settings row gets one with
   * the defaults.
   */
  private async claimSlot(businessId: string, slot: Date): Promise<boolean> {
    const s = telegramNotificationSettings;
    const claimed = await this.db
      .insert(s)
      .values({businessId, dailySalesLastSentAt: slot})
      .onConflictDoUpdate({
        target: s.businessId,
        set: {dailySalesLastSentAt: slot},
        setWhere: or(
          isNull(s.dailySalesLastSentAt),
          lt(s.dailySalesLastSentAt, slot),
        ),
      })
      .returning({businessId: s.businessId});
    return claimed.length > 0;
  }

  /**
   * 09:00 Asia/Tashkent: what ran out or fell under its threshold, before the
   * shop opens — the same counts the phone home shows, plus the out-of-stock
   * products that were actually selling (the ones worth reordering today).
   * Only shops that sold something in the last week; a dormant tenant's empty
   * shelves are nobody's morning news.
   */
  @Cron('0 9 * * *', {name: 'low-stock-digest', timeZone: 'Asia/Tashkent'})
  async runLowStockDigests(): Promise<void> {
    if (process.env.DAILY_DIGEST === 'off') return;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const active = await this.db
      .selectDistinct({id: orders.businessId})
      .from(orders)
      .where(and(eq(orders.status, 'Completed'), gte(orders.createdAt, since)));

    for (const {id} of active) {
      try {
        // Same counts as the phone home (out = nothing left; low = under the
        // threshold the owner set — no default, or a small shop is all "low").
        const stats = await this.productService.getStats(id);
        const out = stats.outOfStock;
        const low = stats.lowAlert ?? 0;
        if (out + low === 0) continue;

        const names = await this.sellingButOut(id);
        const lines = ['📦 Qoldiq ogohlantirishi', `🔴 Tugagan: ${out} ta`];
        if (low > 0) lines.push(`🟡 Kam qolgan: ${low} ta`);
        if (names.length) {
          lines.push('', 'Sotilayotgan, lekin tugaganlar:');
          names.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
        }
        await this.telegramNotify.dispatch(id, 'lowStock', lines.join('\n'), {
          event: 'lowStock',
          data: {out, low, names, url: '/products?stock=out'},
        });
      } catch (e) {
        this.logger.error(`Low-stock digest failed for ${id}: ${(e as Error).message}`);
      }
    }
  }

  /** Up to 5 out-of-stock products, best sellers of the last 30 days first. */
  private async sellingButOut(businessId: string): Promise<string[]> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.db
      .select({
        name: products.name,
        sold: sql<string>`SUM(${orderItems.quantity})`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(
        and(
          eq(orderItems.businessId, businessId),
          eq(orders.status, 'Completed'),
          gte(orders.createdAt, since),
          eq(products.isActive, true),
          lte(products.quantity, 0),
        ),
      )
      .groupBy(products.id, products.name)
      .orderBy(desc(sql`SUM(${orderItems.quantity})`))
      .limit(5);
    return rows.map((r) => r.name);
  }
}

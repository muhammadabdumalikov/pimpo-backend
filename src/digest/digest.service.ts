import {Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {DatabaseService} from '../database/database.service';
import {businesses, orders, orderItems, cashShifts} from '../database/schema';
import {eq, and, gte, lte, sql, desc} from 'drizzle-orm';
import {businessDayStart, businessDayEnd} from '../common/business-time';

export interface DailyDigest {
  date: string; // YYYY-MM-DD (business zone)
  revenue: number;
  orderCount: number;
  avgCheck: number;
  units: number;
  cashDifference: number; // negative = shortage across shifts closed that day
  topProducts: {name: string; qty: number; revenue: number}[];
}

/**
 * Daily owner digest (R30). The digest is COMPUTED here and, for now, logged —
 * the Telegram delivery is a later phase (see sendToTelegram stub). The cron
 * fires at 21:00 Asia/Tashkent and builds a digest for every active business.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  /** Today's date (YYYY-MM-DD) in the business zone (+05:00). */
  private todayYmd(): string {
    return new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
  }

  async buildDigest(businessId: string, date?: string): Promise<DailyDigest> {
    const ymd = /^\d{4}-\d{2}-\d{2}/.test(date ?? '')
      ? (date as string).slice(0, 10)
      : this.todayYmd();
    const start = businessDayStart(ymd);
    const end = businessDayEnd(ymd);

    const dayWhere = and(
      eq(orders.businessId, businessId),
      eq(orders.status, 'Completed'),
      gte(orders.createdAt, start),
      lte(orders.createdAt, end),
    );

    const [sales] = await this.db
      .select({
        revenue: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        orderCount: sql<string>`COUNT(*)`,
        units: sql<string>`COALESCE(SUM(${orders.itemCount}), 0)`,
      })
      .from(orders)
      .where(dayWhere);
    const revenue = Number(sales?.revenue ?? 0);
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
          lte(cashShifts.closedAt, end),
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
      date: ymd,
      revenue,
      orderCount,
      avgCheck: orderCount > 0 ? revenue / orderCount : 0,
      units: Number(sales?.units ?? 0),
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
    const uz = (n: number) => new Intl.NumberFormat('uz-UZ').format(Math.round(n));
    const lines: string[] = [];
    lines.push(`📊 Kunlik hisobot — ${digest.date}`);
    if (businessName) lines.push(`🏪 ${businessName}`);
    lines.push('');
    lines.push(`💰 Tushum: ${uz(digest.revenue)} so'm`);
    lines.push(`🧾 Cheklar: ${uz(digest.orderCount)} ta`);
    lines.push(`🎯 O'rtacha chek: ${uz(digest.avgCheck)} so'm`);
    if (digest.cashDifference < 0) {
      lines.push(`⚠️ Kassa kamomad: ${uz(Math.abs(digest.cashDifference))} so'm`);
    } else if (digest.cashDifference > 0) {
      lines.push(`✅ Kassa ortiqcha: ${uz(digest.cashDifference)} so'm`);
    }
    if (digest.topProducts.length > 0) {
      lines.push('');
      lines.push('🔝 TOP-5 tovar:');
      digest.topProducts.forEach((p, i) => {
        lines.push(`${i + 1}. ${p.name} — ${uz(p.qty)} × / ${uz(p.revenue)} so'm`);
      });
    }
    return lines.join('\n');
  }

  /**
   * Delivery stub — the Telegram bot integration lands in a later phase (the
   * user chose "backend-only for now"). When wired, this reads the business's
   * bot token + chat id and POSTs to the Telegram Bot API.
   */
  private async sendToTelegram(_businessId: string, _message: string): Promise<void> {
    // TODO(R30 phase 2): send `message` to the business's Telegram chat.
  }

  /** 21:00 Asia/Tashkent daily: build + (for now) log a digest per business. */
  @Cron('0 21 * * *', {name: 'daily-digest', timeZone: 'Asia/Tashkent'})
  async runDailyDigests(): Promise<void> {
    if (process.env.DAILY_DIGEST === 'off') return;
    const bizList = await this.db
      .select({id: businesses.id, name: businesses.name})
      .from(businesses)
      .where(eq(businesses.isActive, true));

    let sent = 0;
    for (const b of bizList) {
      try {
        const digest = await this.buildDigest(b.id);
        if (digest.orderCount === 0) continue; // no sales → no digest
        const message = this.formatMessage(digest, b.name);
        this.logger.log(`Daily digest for ${b.name} (${b.id}):\n${message}`);
        await this.sendToTelegram(b.id, message);
        sent += 1;
      } catch (e) {
        this.logger.error(`Digest failed for business ${b.id}: ${(e as Error).message}`);
      }
    }
    this.logger.log(`Daily digest run complete: ${sent}/${bizList.length} businesses.`);
  }
}

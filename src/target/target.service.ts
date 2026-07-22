import {Injectable} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {orders, monthlyTargets} from '../database/schema';
import {eq, and, gte, lte, sql} from 'drizzle-orm';
import {businessDayStart, businessDayEnd} from '../common/business-time';
import {generateId} from '../utils/uuid';

/**
 * Monthly sales targets (Reja vs fakt — R31). Only the goal is stored; the
 * actual is computed live from completed orders in the month, and the pace /
 * projection is derived from how far through the month we are (business zone).
 */
@Injectable()
export class TargetService {
  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  /** Current month 'YYYY-MM' in the business zone (+05:00). */
  private currentMonth(): string {
    const local = new Date(Date.now() + 5 * 3_600_000);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  async getProgress(businessId: string, month?: string) {
    const m = /^\d{4}-\d{2}$/.test(month ?? '') ? (month as string) : this.currentMonth();
    const [year, mon] = m.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const firstDay = `${m}-01`;
    const lastDay = `${m}-${String(daysInMonth).padStart(2, '0')}`;

    const [row] = await this.db
      .select()
      .from(monthlyTargets)
      .where(
        and(
          eq(monthlyTargets.businessId, businessId),
          eq(monthlyTargets.month, m),
        ),
      );
    const revenueTarget = row ? Number(row.revenueTarget) : 0;

    const [act] = await this.db
      .select({
        actual: sql<string>`COALESCE(SUM(${orders.totalAmount}), 0)`,
        orderCount: sql<string>`COUNT(*)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, 'Completed'),
          gte(orders.createdAt, businessDayStart(firstDay)),
          lte(orders.createdAt, businessDayEnd(lastDay)),
        ),
      );
    const actual = Number(act?.actual ?? 0);
    const orderCount = Number(act?.orderCount ?? 0);

    const nowM = this.currentMonth();
    const isCurrentMonth = m === nowM;
    const isFuture = m > nowM;
    let daysElapsed = daysInMonth; // a past month is fully elapsed
    if (isFuture) daysElapsed = 0;
    else if (isCurrentMonth) {
      const local = new Date(Date.now() + 5 * 3_600_000);
      daysElapsed = local.getUTCDate();
    }

    const achievedPct = revenueTarget > 0 ? (actual / revenueTarget) * 100 : 0;
    const expectedPct = daysInMonth > 0 ? (daysElapsed / daysInMonth) * 100 : 0;
    // Straight-line month-end projection from the current run rate.
    const projected =
      isCurrentMonth && daysElapsed > 0
        ? (actual / daysElapsed) * daysInMonth
        : actual;
    // Ahead of the linear pace the target implies (only meaningful mid-month).
    const onTrack = revenueTarget > 0 ? achievedPct >= expectedPct : true;

    return {
      month: m,
      revenueTarget,
      actual,
      orderCount,
      achievedPct,
      expectedPct,
      projected,
      daysElapsed,
      daysInMonth,
      onTrack,
      isCurrentMonth,
      remaining: Math.max(0, revenueTarget - actual),
    };
  }

  async setTarget(businessId: string, month: string, revenueTarget: number) {
    const m = /^\d{4}-\d{2}$/.test(month) ? month : this.currentMonth();
    const val = Math.max(0, Number(revenueTarget) || 0).toFixed(2);

    const [existing] = await this.db
      .select({id: monthlyTargets.id})
      .from(monthlyTargets)
      .where(
        and(
          eq(monthlyTargets.businessId, businessId),
          eq(monthlyTargets.month, m),
        ),
      );

    if (existing) {
      await this.db
        .update(monthlyTargets)
        .set({revenueTarget: val, updatedAt: new Date()})
        .where(eq(monthlyTargets.id, existing.id));
    } else {
      await this.db.insert(monthlyTargets).values({
        id: generateId(),
        businessId,
        month: m,
        revenueTarget: val,
      });
    }

    return this.getProgress(businessId, m);
  }
}

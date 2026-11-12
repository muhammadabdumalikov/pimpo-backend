import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import { BusinessService } from '../business/business.service';
import {StaffService} from '../staff/staff.service';
import { SubscriptionService } from '../subscription/subscription.service';
import {
  BillingService,
  type PlatformBillingSummary,
} from '../billing/billing.service';
import { isPastEnd, isRestricted } from '../billing/billing';
import {
  businesses,
  products,
  branches,
  staff,
  businessSubscriptions,
  subscriptionPlans,
  billingProfiles,
  cashRegisters,
  orders,
  saleReturns,
  userDebts,
  goodsReceipts,
  telegramLinks,
  loyaltySettings,
  loyaltyTransactions,
  aiAssistantSettings,
  customerChatMessages,
} from '../database/schema';
import type {BusinessType} from '../common/business-type';
import { and, count, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import {
  BUSINESS_OFFSET_MS,
  businessBuckets,
  businessDay,
  businessDayEnd,
  businessDayStart,
} from '../common/business-time';
import {
  TIER_RANK,
  type Tier,
  gateTier,
  tierAtLeast,
  type PlanTier,
} from '../subscription/tier';

/** One row in the platform businesses overview table. */
export interface PlatformBusinessRow {
  id: string;
  name: string;
  login: string;
  email: string | null;
  isActive: boolean;
  businessType: BusinessType;
  createdAt: Date;
  /** Effective tier after expiry/active checks (free when none/expired). */
  tier: Tier;
  /** Raw plan tier on the active subscription row, before expiry gating. */
  planTier: string | null;
  subscriptionEndDate: Date | null;
  subscriptionExpired: boolean;
  balance: number;
  /** Billing stage for the console's status column/filter (OBUNA-TOLOV.md §6.2). */
  billing: PlatformBillingSummary;
  productCount: number;
  branchCount: number;
  staffCount: number;
}

/**
 * How alive a shop is, read off its completed sales:
 * active = sold within the last 7 days, slowing = last sale 7–30 days ago,
 * stopped = 30+ days ago, never = no completed sale at all.
 */
export type ShopActivityStatus = 'active' | 'slowing' | 'stopped' | 'never';

/** The modules whose use the platform owner tracks per shop. */
export type ShopModuleKey =
  | 'credit'
  | 'receipts'
  | 'telegram'
  | 'online'
  | 'loyalty'
  | 'assistant';

/**
 * The lowest plan that includes each module — the same gates the routes
 * enforce (@MinTier) and the pricing page promises. Credit sales are in every
 * plan.
 */
const MODULE_MIN_TIER: Record<ShopModuleKey, Tier> = {
  credit: 'free',
  receipts: 'basic',
  telegram: 'basic',
  online: 'pro',
  loyalty: 'pro',
  assistant: 'pro',
};

/** One window set of a per-day figure. */
interface WindowTotals {
  today: number;
  last7: number;
  prev7: number;
  last30: number;
  prev30: number;
}

/** Shop statistics for the platform console. */
export interface PlatformShopStats {
  /** Today's calendar day in the business zone (Asia/Tashkent). */
  today: string;
  activity: {
    status: ShopActivityStatus;
    /** Most recent completed sale (ISO, UTC); null when the shop never sold. */
    lastSaleAt: string | null;
    /** Completed sales per window. Windows are whole business-zone days ending today. */
    sales: WindowTotals;
    /**
     * Turnover in so'm over the same windows: completed sales less the
     * returns made on those days (a return is dated on its own day, as in
     * every revenue report).
     */
    revenue: WindowTotals;
    /** Days with at least one completed sale among the last 30. */
    activeDays30: number;
    /** One point per day for the last 30 days, oldest first, zero-filled. */
    daily: {date: string; count: number}[];
  };
  size: {
    products: number;
    branches: number;
    cashRegisters: number;
    /** Seats as the staff page counts them: owner + active account holders. */
    staffAccounts: {used: number; limit: number | null};
  };
  /** The plan the shop is effectively on (an expired plan reads as free). */
  tier: Tier;
  /** Use of each module over the last 30 days. */
  modules: {
    key: ShopModuleKey;
    minTier: Tier;
    /** The shop's plan includes it. */
    available: boolean;
    /** Switched on / connected, where the module has such a switch; else null. */
    enabled: boolean | null;
    /** Events in the last 30 days (debts written, receipts taken, …). */
    used30: number;
  }[];
  /** The customer bot's work this calendar month — the platform pays for it. */
  assistantMonth: {replies: number; tokensIn: number; tokensOut: number};
}

/** Calendar day `days` before `ymd` (both 'YYYY-MM-DD'). */
function shiftDay(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

@Injectable()
export class PlatformService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly businessService: BusinessService,
    private readonly subscriptionService: SubscriptionService,
    private readonly billingService: BillingService,
    private readonly staffService: StaffService,
  ) {}

  /**
   * Effective tier from a raw plan tier + end date, mirroring SubscriptionService:
   * the plan holds through the grace period after end_date.
   */
  private effectiveTier(planTier: string | null, endDate: Date | null): Tier {
    if (!planTier) return 'free';
    if (isRestricted(endDate)) return 'free';
    return gateTier(planTier);
  }

  /** Businesses registered within the given calendar days (both inclusive, business zone). */
  private createdWithin(from?: string, to?: string) {
    return and(
      from ? gte(businesses.createdAt, businessDayStart(from)) : undefined,
      to ? lte(businesses.createdAt, businessDayEnd(to)) : undefined,
    );
  }

  /**
   * All businesses with the aggregate figures the overview table needs. Counts
   * are computed with a handful of grouped queries (not per-row) and merged in
   * memory, so listing stays O(1) queries regardless of tenant count.
   */
  async listBusinesses(search?: string): Promise<PlatformBusinessRow[]> {
    const term = search?.trim();
    const where = term
      ? or(
          ilike(businesses.name, `%${term}%`),
          ilike(businesses.login, `%${term}%`),
          ilike(businesses.email, `%${term}%`),
        )
      : undefined;

    const [rows, productCounts, branchCounts, staffCounts, subs, profiles, billing] =
      await Promise.all([
        this.dbService.db
          .select({
            id: businesses.id,
            name: businesses.name,
            login: businesses.login,
            email: businesses.email,
            isActive: businesses.isActive,
            businessType: businesses.businessType,
            createdAt: businesses.createdAt,
          })
          .from(businesses)
          .where(where)
          .orderBy(sql`${businesses.createdAt} DESC`),
        this.dbService.db
          .select({
            businessId: products.businessId,
            c: count(),
          })
          .from(products)
          .where(eq(products.isActive, true))
          .groupBy(products.businessId),
        this.dbService.db
          .select({ businessId: branches.businessId, c: count() })
          .from(branches)
          .where(eq(branches.isActive, true))
          .groupBy(branches.businessId),
        this.dbService.db
          // Seats, not headcount: accountless payroll-only employees don't
          // consume a user slot, so they must not show up as users here.
          .select({ businessId: staff.businessId, c: count() })
          .from(staff)
          .where(and(eq(staff.isActive, true), eq(staff.hasAccount, true)))
          .groupBy(staff.businessId),
        this.dbService.db
          .select({
            businessId: businessSubscriptions.businessId,
            endDate: businessSubscriptions.endDate,
            planTier: subscriptionPlans.tier,
          })
          .from(businessSubscriptions)
          .innerJoin(
            subscriptionPlans,
            eq(businessSubscriptions.planId, subscriptionPlans.id),
          )
          .where(eq(businessSubscriptions.isActive, true)),
        this.dbService.db
          .select({
            businessId: billingProfiles.businessId,
            balance: billingProfiles.balance,
          })
          .from(billingProfiles),
        this.billingService.platformSummaries(),
      ]);

    const productMap = new Map(productCounts.map((r) => [r.businessId, r.c]));
    const branchMap = new Map(branchCounts.map((r) => [r.businessId, r.c]));
    const staffMap = new Map(staffCounts.map((r) => [r.businessId, r.c]));
    const subMap = new Map(subs.map((r) => [r.businessId, r]));
    const balanceMap = new Map(
      profiles.map((r) => [r.businessId, Number(r.balance)]),
    );

    return rows.map((b) => {
      const sub = subMap.get(b.id);
      const planTier = sub?.planTier ?? null;
      const endDate = sub?.endDate ?? null;
      return {
        ...b,
        businessType: b.businessType as BusinessType,
        planTier,
        subscriptionEndDate: endDate,
        subscriptionExpired: isPastEnd(endDate),
        tier: this.effectiveTier(planTier, endDate),
        balance: balanceMap.get(b.id) ?? 0,
        billing: billing.get(b.id) ?? {
          stage: 'none',
          amountDue: 0,
          isTrial: false,
          paymentPending: false,
        },
        productCount: productMap.get(b.id) ?? 0,
        branchCount: branchMap.get(b.id) ?? 0,
        staffCount: staffMap.get(b.id) ?? 0,
      };
    });
  }

  /** Full detail for one business: profile + counts + subscription + billing. */
  async getBusinessDetail(id: string) {
    const business = await this.businessService.findById(id);
    if (!business) {
      throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
    }

    const [productRows, branchRows, staffRows, subscription, billing] =
      await Promise.all([
        this.dbService.db
          .select({ c: count() })
          .from(products)
          .where(
            and(eq(products.businessId, id), eq(products.isActive, true)),
          ),
        this.dbService.db
          .select({ c: count() })
          .from(branches)
          .where(and(eq(branches.businessId, id), eq(branches.isActive, true))),
        this.dbService.db
          .select({ c: count() })
          .from(staff)
          .where(
            and(
              eq(staff.businessId, id),
              eq(staff.isActive, true),
              eq(staff.hasAccount, true),
            ),
          ),
        this.subscriptionService.getBusinessSubscription(id),
        this.subscriptionService.getBillingInfo(id),
      ]);

    const { password: _pw, ...safeBusiness } = business;
    // May be an ISO string when the subscription came from the Redis cache.
    const endDate = subscription?.endDate ? new Date(subscription.endDate) : null;
    const planTier = subscription?.plan.tier ?? null;

    return {
      business: safeBusiness,
      counts: {
        products: productRows[0]?.c ?? 0,
        branches: branchRows[0]?.c ?? 0,
        staff: staffRows[0]?.c ?? 0,
      },
      subscription: subscription
        ? {
            tier: this.effectiveTier(planTier, endDate),
            planTier,
            planName: subscription.plan.name,
            startDate: subscription.startDate,
            endDate,
            isExpired: isPastEnd(endDate),
            isTrial: subscription.isTrial ?? false,
          }
        : { tier: 'free' as Tier, planTier: null, planName: null, startDate: null, endDate: null, isExpired: false, isTrial: false },
      billing,
    };
  }

  /**
   * Activity and size of one shop. A sale is a completed order dated by
   * created_at, as the sales reports date it (a storefront order's created_at
   * moves to its completion). Days are calendar days in the business zone.
   */
  async getBusinessStats(id: string): Promise<PlatformShopStats> {
    await this.assertBusiness(id);

    const today = businessDay();
    // 60 days back covers the last 30 and the 30 before them.
    const since = businessDayStart(shiftDay(today, 59));
    const completed = and(
      eq(orders.businessId, id),
      eq(orders.status, 'Completed'),
    );
    // No bound parameters, so reusing it in SELECT and GROUP BY is safe.
    const day = sql<string>`to_char(${orders.createdAt} + interval '5 hours', 'YYYY-MM-DD')`;
    const returnDay = sql<string>`to_char(${saleReturns.createdAt} + interval '5 hours', 'YYYY-MM-DD')`;
    const since30 = businessDayStart(shiftDay(today, 29));
    const monthStart = businessDayStart(`${today.slice(0, 8)}01`);
    const one = <T,>(rows: T[]) => rows[0];

    const [
      lastRows,
      dayRows,
      productRows,
      branchRows,
      registerRows,
      seats,
      returnRows,
      subscription,
      debtRows,
      receiptRows,
      onlineRows,
      telegramRows,
      loyaltyRows,
      loyaltySwitch,
      assistantRows,
      assistantSwitch,
      botRows,
    ] = await Promise.all([
        this.dbService.db
          .select({
            last: sql<
              string | null
            >`MAX(${orders.createdAt}) AT TIME ZONE 'UTC'`,
          })
          .from(orders)
          .where(completed),
        this.dbService.db
          .select({
            day,
            c: count(),
            amount: sql<string>`coalesce(sum(${orders.totalAmount}), 0)`,
          })
          .from(orders)
          .where(and(completed, gte(orders.createdAt, since)))
          .groupBy(day),
        this.dbService.db
          .select({c: count()})
          .from(products)
          .where(and(eq(products.businessId, id), eq(products.isActive, true))),
        this.dbService.db
          .select({c: count()})
          .from(branches)
          .where(and(eq(branches.businessId, id), eq(branches.isActive, true))),
        this.dbService.db
          .select({c: count()})
          .from(cashRegisters)
          .where(
            and(
              eq(cashRegisters.businessId, id),
              eq(cashRegisters.isActive, true),
            ),
          ),
        this.staffService.getSeatUsage(id),
        this.dbService.db
          .select({
            day: returnDay,
            amount: sql<string>`coalesce(sum(${saleReturns.totalAmount}), 0)`,
          })
          .from(saleReturns)
          .where(
            and(eq(saleReturns.businessId, id), gte(saleReturns.createdAt, since)),
          )
          .groupBy(returnDay),
        this.subscriptionService.getBusinessSubscription(id),
        this.dbService.db
          .select({c: count()})
          .from(userDebts)
          .where(and(eq(userDebts.businessId, id), gte(userDebts.createdAt, since30))),
        this.dbService.db
          .select({c: count()})
          .from(goodsReceipts)
          .where(
            and(eq(goodsReceipts.businessId, id), gte(goodsReceipts.createdAt, since30)),
          ),
        this.dbService.db
          .select({c: count()})
          .from(orders)
          .where(
            and(
              eq(orders.businessId, id),
              eq(orders.source, 'store'),
              gte(orders.createdAt, since30),
            ),
          ),
        // Connected accounts, and how many of them were sent anything lately.
        this.dbService.db
          .select({
            linked: count(),
            sent: sql<string>`count(*) filter (where ${telegramLinks.lastSentAt} >= ${since30.toISOString().slice(0, 23).replace('T', ' ')}::timestamp)`,
          })
          .from(telegramLinks)
          .where(and(eq(telegramLinks.businessId, id), eq(telegramLinks.isActive, true))),
        this.dbService.db
          .select({c: count()})
          .from(loyaltyTransactions)
          .where(
            and(
              eq(loyaltyTransactions.businessId, id),
              gte(loyaltyTransactions.createdAt, since30),
            ),
          ),
        this.dbService.db
          .select({enabled: loyaltySettings.enabled})
          .from(loyaltySettings)
          .where(eq(loyaltySettings.businessId, id)),
        this.dbService.db
          .select({c: count()})
          .from(customerChatMessages)
          .where(
            and(
              eq(customerChatMessages.businessId, id),
              eq(customerChatMessages.role, 'customer'),
              gte(customerChatMessages.createdAt, since30),
            ),
          ),
        this.dbService.db
          .select({enabled: aiAssistantSettings.enabled})
          .from(aiAssistantSettings)
          .where(eq(aiAssistantSettings.businessId, id)),
        this.dbService.db
          .select({
            c: count(),
            tokensIn: sql<string>`coalesce(sum(${customerChatMessages.tokensIn}), 0)`,
            tokensOut: sql<string>`coalesce(sum(${customerChatMessages.tokensOut}), 0)`,
          })
          .from(customerChatMessages)
          .where(
            and(
              eq(customerChatMessages.businessId, id),
              eq(customerChatMessages.role, 'bot'),
              gte(customerChatMessages.createdAt, monthStart),
            ),
          ),
      ]);

    const perDay = new Map(dayRows.map((r) => [r.day, Number(r.c)]));
    const sumDays = (fromBack: number, toBack: number) => {
      let total = 0;
      for (let i = fromBack; i <= toBack; i++) {
        total += perDay.get(shiftDay(today, i)) ?? 0;
      }
      return total;
    };
    const windows = (sum: (fromBack: number, toBack: number) => number) => ({
      today: sum(0, 0),
      last7: sum(0, 6),
      prev7: sum(7, 13),
      last30: sum(0, 29),
      prev30: sum(30, 59),
    });
    const sales = windows(sumDays);

    // Turnover: the day's completed sales less the returns made that day.
    const netPerDay = new Map(dayRows.map((r) => [r.day, Number(r.amount)]));
    for (const r of returnRows) {
      netPerDay.set(r.day, (netPerDay.get(r.day) ?? 0) - Number(r.amount));
    }
    const revenue = windows((fromBack, toBack) => {
      let total = 0;
      for (let i = fromBack; i <= toBack; i++) {
        total += netPerDay.get(shiftDay(today, i)) ?? 0;
      }
      return Math.round(total);
    });

    const subEnd = subscription?.endDate ? new Date(subscription.endDate) : null;
    const tier = this.effectiveTier(subscription?.plan.tier ?? null, subEnd);
    const moduleUse: Record<ShopModuleKey, {enabled: boolean | null; used30: number}> = {
      credit: {enabled: null, used30: Number(one(debtRows)?.c ?? 0)},
      receipts: {enabled: null, used30: Number(one(receiptRows)?.c ?? 0)},
      telegram: {
        enabled: Number(one(telegramRows)?.linked ?? 0) > 0,
        used30: Number(one(telegramRows)?.sent ?? 0),
      },
      online: {enabled: null, used30: Number(one(onlineRows)?.c ?? 0)},
      loyalty: {
        enabled: one(loyaltySwitch)?.enabled ?? false,
        used30: Number(one(loyaltyRows)?.c ?? 0),
      },
      assistant: {
        enabled: one(assistantSwitch)?.enabled ?? false,
        used30: Number(one(assistantRows)?.c ?? 0),
      },
    };
    const modules = (Object.keys(MODULE_MIN_TIER) as ShopModuleKey[]).map(
      (key) => ({
        key,
        minTier: MODULE_MIN_TIER[key],
        available: tierAtLeast(tier, MODULE_MIN_TIER[key]),
        ...moduleUse[key],
      }),
    );
    const daily = businessBuckets('day', shiftDay(today, 29), today).map(
      (date) => ({date, count: perDay.get(date) ?? 0}),
    );

    const lastRaw = lastRows[0]?.last ?? null;
    const lastSaleAt = lastRaw ? new Date(lastRaw).toISOString() : null;

    // Bucketed by the same calendar days as the counts, so a shop that shows
    // sales this week always reads as active.
    let status: ShopActivityStatus = 'never';
    if (lastSaleAt) {
      const lastDay = new Date(Date.parse(lastSaleAt) + BUSINESS_OFFSET_MS)
        .toISOString()
        .slice(0, 10);
      status =
        lastDay >= shiftDay(today, 6)
          ? 'active'
          : lastDay >= shiftDay(today, 29)
            ? 'slowing'
            : 'stopped';
    }

    return {
      today,
      activity: {
        status,
        lastSaleAt,
        sales,
        revenue,
        activeDays30: daily.filter((d) => d.count > 0).length,
        daily,
      },
      size: {
        products: Number(productRows[0]?.c ?? 0),
        branches: Number(branchRows[0]?.c ?? 0),
        cashRegisters: Number(registerRows[0]?.c ?? 0),
        staffAccounts: seats,
      },
      tier,
      modules,
      assistantMonth: {
        replies: Number(one(botRows)?.c ?? 0),
        tokensIn: Number(one(botRows)?.tokensIn ?? 0),
        tokensOut: Number(one(botRows)?.tokensOut ?? 0),
      },
    };
  }

  /**
   * Aggregate figures for the platform dashboard home. A date range narrows
   * every figure to the shops registered in it, so they add up to what the
   * businesses table lists for the same range.
   */
  async getStats(from?: string, to?: string) {
    const createdWithin = this.createdWithin(from, to);
    const [bizAgg, subs, productAgg] = await Promise.all([
      this.dbService.db
        .select({
          total: count(),
          active: sql<number>`count(*) filter (where ${businesses.isActive})`,
        })
        .from(businesses)
        .where(createdWithin),
      this.dbService.db
        .select({
          businessId: businessSubscriptions.businessId,
          endDate: businessSubscriptions.endDate,
          planTier: subscriptionPlans.tier,
        })
        .from(businessSubscriptions)
        .innerJoin(
          subscriptionPlans,
          eq(businessSubscriptions.planId, subscriptionPlans.id),
        )
        .innerJoin(businesses, eq(businessSubscriptions.businessId, businesses.id))
        .where(and(eq(businessSubscriptions.isActive, true), createdWithin)),
      this.dbService.db
        .select({ c: count() })
        .from(products)
        .innerJoin(businesses, eq(products.businessId, businesses.id))
        .where(and(eq(products.isActive, true), createdWithin)),
    ]);

    const byTier: Record<Tier, number> = {
      free: 0,
      basic: 0,
      pro: 0,
      proplus: 0,
    };
    for (const s of subs) {
      const tier = this.effectiveTier(s.planTier, s.endDate);
      byTier[tier] += 1;
    }
    const total = Number(bizAgg[0]?.total ?? 0);
    const active = Number(bizAgg[0]?.active ?? 0);
    // Businesses with no active subscription row at all also count as free.
    byTier.free += Math.max(0, total - subs.length);

    return {
      totalBusinesses: total,
      activeBusinesses: active,
      blockedBusinesses: total - active,
      totalProducts: Number(productAgg[0]?.c ?? 0),
      byTier,
    };
  }

  /** Create a new business (delegates to BusinessService — seeds a trial too). */
  async createBusiness(data: {
    name: string;
    email?: string;
    login: string;
    password: string;
    businessType?: BusinessType;
  }) {
    const business = await this.businessService.create(data);
    const { password: _pw, ...safe } = business;
    return safe;
  }

  /** Update a business's profile / active flag. */
  async updateBusiness(
    id: string,
    data: {
      name?: string;
      email?: string;
      login?: string;
      password?: string;
      isActive?: boolean;
      businessType?: BusinessType;
    },
  ) {
    const business = await this.businessService.update(id, data);
    const { password: _pw, ...safe } = business;
    return safe;
  }

  /** Permanently delete a business (cascades to its data via FK onDelete). */
  async deleteBusiness(id: string) {
    await this.businessService.delete(id);
  }

  /** Set a business's subscription tier (and optional expiry). */
  async setSubscription(
    id: string,
    tier: PlanTier,
    endDate?: string,
    isTrial?: boolean,
  ) {
    const business = await this.businessService.findById(id);
    if (!business) {
      throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
    }
    // Omitted endDate → open-ended (unlimited); provided → that expiry.
    const parsed = endDate ? new Date(endDate) : null;
    const subscription = await this.subscriptionService.updateBusinessSubscription(
      id,
      tier,
      parsed,
      { isTrial: isTrial ?? false },
    );
    return {
      tier: this.effectiveTier(
        subscription.plan.tier,
        subscription.endDate ?? null,
      ),
      planTier: subscription.plan.tier,
      planName: subscription.plan.name,
      startDate: subscription.startDate,
      endDate: subscription.endDate ?? null,
      isTrial: subscription.isTrial,
    };
  }

  // ── Billing (delegates to SubscriptionService, guards existence first) ──────
  private async assertBusiness(id: string): Promise<void> {
    const business = await this.businessService.findById(id);
    if (!business) throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
  }

  async topUpBalance(id: string, amount: number, note?: string) {
    await this.assertBusiness(id);
    return this.billingService.topUp(id, amount, note);
  }

  async adjustBalance(id: string, amount: number, note: string) {
    await this.assertBusiness(id);
    return this.billingService.adjust(id, amount, note);
  }

  async listTransactions(id: string, page?: number, limit?: number) {
    await this.assertBusiness(id);
    return this.billingService.listTransactions(id, { page, limit, internal: true });
  }

  async createDiscount(
    id: string,
    data: { label: string; percent: number; validUntil?: string },
  ) {
    await this.assertBusiness(id);
    return this.subscriptionService.createDiscount(id, data);
  }

  async deleteDiscount(discountId: string) {
    return this.subscriptionService.deleteDiscount(discountId);
  }
}

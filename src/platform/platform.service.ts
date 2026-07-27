import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import { BusinessService } from '../business/business.service';
import { SubscriptionService } from '../subscription/subscription.service';
import {
  businesses,
  products,
  branches,
  staff,
  businessSubscriptions,
  subscriptionPlans,
  billingProfiles,
} from '../database/schema';
import { and, count, eq, ilike, or, sql } from 'drizzle-orm';
import { TIER_RANK, type Tier } from '../subscription/tier';

/** One row in the platform businesses overview table. */
export interface PlatformBusinessRow {
  id: string;
  name: string;
  login: string;
  email: string | null;
  isActive: boolean;
  createdAt: Date;
  /** Effective tier after expiry/active checks (free when none/expired). */
  tier: Tier;
  /** Raw plan tier on the active subscription row, before expiry gating. */
  planTier: string | null;
  subscriptionEndDate: Date | null;
  subscriptionExpired: boolean;
  balance: number;
  productCount: number;
  branchCount: number;
  staffCount: number;
}

@Injectable()
export class PlatformService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly businessService: BusinessService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /** Effective tier from a raw plan tier + end date, mirroring SubscriptionService. */
  private effectiveTier(planTier: string | null, endDate: Date | null): Tier {
    if (!planTier) return 'free';
    const expired = endDate != null && endDate.getTime() <= Date.now();
    if (expired) return 'free';
    return TIER_RANK[planTier as Tier] !== undefined ? (planTier as Tier) : 'free';
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

    const [rows, productCounts, branchCounts, staffCounts, subs, profiles] =
      await Promise.all([
        this.dbService.db
          .select({
            id: businesses.id,
            name: businesses.name,
            login: businesses.login,
            email: businesses.email,
            isActive: businesses.isActive,
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
        planTier,
        subscriptionEndDate: endDate,
        subscriptionExpired:
          endDate != null && endDate.getTime() <= Date.now(),
        tier: this.effectiveTier(planTier, endDate),
        balance: balanceMap.get(b.id) ?? 0,
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
    const endDate = subscription?.endDate ?? null;
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
            isExpired: endDate != null && endDate.getTime() <= Date.now(),
          }
        : { tier: 'free' as Tier, planTier: null, planName: null, startDate: null, endDate: null, isExpired: false },
      billing,
    };
  }

  /** Aggregate figures for the platform dashboard home. */
  async getStats() {
    const [bizAgg, subs, productAgg] = await Promise.all([
      this.dbService.db
        .select({
          total: count(),
          active: sql<number>`count(*) filter (where ${businesses.isActive})`,
        })
        .from(businesses),
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
        .select({ c: count() })
        .from(products)
        .where(eq(products.isActive, true)),
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
    tier: Tier,
    endDate?: string,
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
    };
  }

  // ── Billing (delegates to SubscriptionService, guards existence first) ──────
  private async assertBusiness(id: string): Promise<void> {
    const business = await this.businessService.findById(id);
    if (!business) throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
  }

  async topUpBalance(id: string, amount: number) {
    await this.assertBusiness(id);
    return this.subscriptionService.topUpBalance(id, amount);
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

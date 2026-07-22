import { Injectable, OnModuleInit, Inject } from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { DatabaseService } from '../database/database.service';
import {
  subscriptionPlans,
  businessSubscriptions,
  billingProfiles,
  subscriptionDiscounts,
  branches,
  type SubscriptionPlan,
  type BusinessSubscription,
  type BillingProfile,
  type SubscriptionDiscount,
} from '../database/schema';
import { eq, and, desc } from 'drizzle-orm';
import { seedSubscriptionPlans } from './seed-plans';
import { CacheKeys, TTL } from '../cache/cache.util';
import { TIER_RANK, type Tier } from './tier';

// Monthly price of each branch beyond the first (base) one. Mirrors the
// "+150 000" extra-location line in the plan comparison table.
const EXTRA_BRANCH_PRICE = 150_000;

// Shape returned by GET /subscriptions/billing — everything the subscription
// status page needs in one call.
export type BillingInfo = {
  balance: number;
  legalName: string | null;
  inn: string | null;
  contractNumber: string | null;
  contractDate: Date | null;
  monthly: {
    planTier: string | null;
    planName: string | null;
    planPrice: number;
    extraBranches: number;
    extraBranchPrice: number;
    extraBranchesTotal: number;
    discountPercent: number;
    discountAmount: number;
    total: number;
  };
  discounts: Pick<SubscriptionDiscount, 'id' | 'label' | 'percent' | 'validUntil'>[];
};

// Limits applied to a business with no active plan (never subscribed, or trial
// expired). Mirrors the deactivated internal `free` floor.
const FLOOR_LIMITS = {
  debtsLimit: 20,
  productsLimit: 100,
  usersLimit: 1,
  branchesLimit: 1,
} as const;

@Injectable()
export class SubscriptionService implements OnModuleInit {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async onModuleInit() {
    // Seed subscription plans on module initialization
    await seedSubscriptionPlans(this.dbService);
  }

  async getAllPlans(): Promise<SubscriptionPlan[]> {
    // Global plan catalogue — rarely changes; cached with a long TTL and
    // invalidated on create/update/delete of a plan. Only active plans are
    // exposed, so the deactivated internal `free` floor never shows up in the
    // pricing/upgrade lists.
    return this.cache.wrap(
      CacheKeys.plansAll(),
      () =>
        this.dbService.db
          .select()
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.isActive, true))
          .orderBy(subscriptionPlans.price),
      TTL.PLANS,
    );
  }

  /** True once a subscription's trial/paid window has ended. */
  private isExpired(sub: { endDate: Date | null }): boolean {
    return sub.endDate != null && sub.endDate.getTime() <= Date.now();
  }

  /**
   * The tier gating should treat this business as: the plan's tier while the
   * subscription is active and not expired, otherwise the `free` floor. This is
   * the single source of truth the PlanTierGuard consults.
   */
  async getEffectiveTier(businessId: string): Promise<Tier> {
    const subscription = await this.getBusinessSubscription(businessId);
    if (!subscription || !subscription.isActive || this.isExpired(subscription)) {
      return 'free';
    }
    const tier = subscription.plan.tier as Tier;
    return TIER_RANK[tier] !== undefined ? tier : 'free';
  }

  async getPlanByTier(tier: string): Promise<SubscriptionPlan | null> {
    const [plan] = await this.dbService.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.tier, tier))
      .limit(1);

    return plan || null;
  }

  async getBusinessSubscription(
    businessId: string,
  ): Promise<(BusinessSubscription & { plan: SubscriptionPlan }) | null> {
    // Per-business active subscription. Feeds both /current and /limits.
    // Invalidated whenever the subscription is changed/cancelled below.
    return this.cache.wrap(
      CacheKeys.subscriptionCurrent(businessId),
      () => this.fetchBusinessSubscription(businessId),
      TTL.SUBSCRIPTION,
    );
  }

  private async fetchBusinessSubscription(
    businessId: string,
  ): Promise<(BusinessSubscription & { plan: SubscriptionPlan }) | null> {
    const [subscription] = await this.dbService.db
      .select({
        id: businessSubscriptions.id,
        businessId: businessSubscriptions.businessId,
        planId: businessSubscriptions.planId,
        startDate: businessSubscriptions.startDate,
        endDate: businessSubscriptions.endDate,
        isActive: businessSubscriptions.isActive,
        createdAt: businessSubscriptions.createdAt,
        updatedAt: businessSubscriptions.updatedAt,
        plan: subscriptionPlans,
      })
      .from(businessSubscriptions)
      .innerJoin(
        subscriptionPlans,
        eq(businessSubscriptions.planId, subscriptionPlans.id),
      )
      .where(
        and(
          eq(businessSubscriptions.businessId, businessId),
          eq(businessSubscriptions.isActive, true),
        ),
      )
      .orderBy(desc(businessSubscriptions.createdAt))
      .limit(1);

    return subscription || null;
  }

  async updateBusinessSubscription(
    businessId: string,
    planTier: string,
  ): Promise<BusinessSubscription & { plan: SubscriptionPlan }> {
    // Get the plan
    const plan = await this.getPlanByTier(planTier);
    if (!plan) {
      throw new AppException(ErrorCode.SUBSCRIPTION_PLAN_TIER_NOT_FOUND, { tier: planTier });
    }

    // Deactivate current subscription
    await this.dbService.db
      .update(businessSubscriptions)
      .set({ isActive: false })
      .where(
        and(
          eq(businessSubscriptions.businessId, businessId),
          eq(businessSubscriptions.isActive, true),
        ),
      );

    // Create new subscription
    const { generateId } = await import('../utils/uuid');
    const newSubscription = {
      id: generateId(),
      businessId,
      planId: plan.id,
      isActive: true,
    };

    const [subscription] = await this.dbService.db
      .insert(businessSubscriptions)
      .values(newSubscription)
      .returning();

    // Drop the stale cache before re-reading so the fresh subscription is
    // returned (and re-cached) instead of the previous plan.
    await this.cache.del(CacheKeys.subscriptionCurrent(businessId));

    // Get subscription with plan
    const result = await this.getBusinessSubscription(businessId);
    if (!result) {
      throw new AppException(ErrorCode.SUBSCRIPTION_CREATE_FAILED);
    }

    return result;
  }

  async getSubscriptionLimits(businessId: string): Promise<{
    debtsLimit: number | null;
    productsLimit: number | null;
    usersLimit: number | null;
    branchesLimit: number | null;
  }> {
    const subscription = await this.getBusinessSubscription(businessId);

    if (!subscription || !subscription.isActive || this.isExpired(subscription)) {
      // No active plan or trial expired → internal floor limits.
      return { ...FLOOR_LIMITS };
    }

    return {
      debtsLimit: subscription.plan.debtsLimit,
      productsLimit: subscription.plan.productsLimit,
      usersLimit: subscription.plan.usersLimit,
      branchesLimit: subscription.plan.branchesLimit,
    };
  }

  async cancelBusinessSubscription(businessId: string): Promise<void> {
    // Deactivate current subscription
    await this.dbService.db
      .update(businessSubscriptions)
      .set({ isActive: false })
      .where(
        and(
          eq(businessSubscriptions.businessId, businessId),
          eq(businessSubscriptions.isActive, true),
        ),
      );

    await this.cache.del(CacheKeys.subscriptionCurrent(businessId));
  }

  // Admin methods for managing plans
  async createPlan(data: {
    tier: string;
    name: string;
    description?: string;
    price: string;
    debtsLimit?: number | null;
    productsLimit?: number | null;
    usersLimit?: number | null;
    branchesLimit?: number | null;
    isActive?: boolean;
  }): Promise<SubscriptionPlan> {
    // Check if tier already exists
    const existing = await this.getPlanByTier(data.tier);
    if (existing) {
      throw new AppException(ErrorCode.SUBSCRIPTION_PLAN_TIER_EXISTS, { tier: data.tier });
    }

    const { generateId } = await import('../utils/uuid');
    const newPlan = {
      id: generateId(),
      tier: data.tier,
      name: data.name,
      description: data.description || null,
      price: data.price,
      isActive: data.isActive !== undefined ? data.isActive : true,
      debtsLimit: data.debtsLimit !== undefined ? data.debtsLimit : null,
      productsLimit: data.productsLimit !== undefined ? data.productsLimit : null,
      usersLimit: data.usersLimit !== undefined ? data.usersLimit : null,
      branchesLimit: data.branchesLimit !== undefined ? data.branchesLimit : null,
    };

    const [plan] = await this.dbService.db
      .insert(subscriptionPlans)
      .values(newPlan)
      .returning();

    await this.cache.del(CacheKeys.plansAll());

    return plan;
  }

  async updatePlan(
    planId: string,
    data: {
      name?: string;
      description?: string;
      price?: string;
      debtsLimit?: number | null;
      productsLimit?: number | null;
      usersLimit?: number | null;
      branchesLimit?: number | null;
      isActive?: boolean;
    },
  ): Promise<SubscriptionPlan> {
    const [existing] = await this.dbService.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    if (!existing) {
      throw new AppException(ErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND, { planId });
    }

    const updateData: Partial<typeof subscriptionPlans.$inferInsert> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.price !== undefined) updateData.price = data.price;
    if (data.debtsLimit !== undefined) updateData.debtsLimit = data.debtsLimit;
    if (data.productsLimit !== undefined) updateData.productsLimit = data.productsLimit;
    if (data.usersLimit !== undefined) updateData.usersLimit = data.usersLimit;
    if (data.branchesLimit !== undefined) updateData.branchesLimit = data.branchesLimit;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    const [plan] = await this.dbService.db
      .update(subscriptionPlans)
      .set(updateData)
      .where(eq(subscriptionPlans.id, planId))
      .returning();

    await this.cache.del(CacheKeys.plansAll());
    await this.cache.del(CacheKeys.planById(planId));

    return plan;
  }

  async deletePlan(planId: string): Promise<void> {
    const [plan] = await this.dbService.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    if (!plan) {
      throw new AppException(ErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND, { planId });
    }

    // Soft delete - set isActive to false
    await this.dbService.db
      .update(subscriptionPlans)
      .set({ isActive: false })
      .where(eq(subscriptionPlans.id, planId));

    await this.cache.del(CacheKeys.plansAll());
    await this.cache.del(CacheKeys.planById(planId));
  }

  async getPlanById(planId: string): Promise<SubscriptionPlan | null> {
    return this.cache.wrap(
      CacheKeys.planById(planId),
      () => this.fetchPlanById(planId),
      TTL.PLANS,
    );
  }

  private async fetchPlanById(planId: string): Promise<SubscriptionPlan | null> {
    const [plan] = await this.dbService.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    return plan || null;
  }

  // ============================================
  // Billing — balance, legal details, monthly breakdown, discounts
  // ============================================

  /** Everything the subscription status page needs, in one cached call. */
  async getBillingInfo(businessId: string): Promise<BillingInfo> {
    return this.cache.wrap(
      CacheKeys.subscriptionBilling(businessId),
      () => this.fetchBillingInfo(businessId),
      TTL.SUBSCRIPTION,
    );
  }

  private async fetchBillingInfo(businessId: string): Promise<BillingInfo> {
    const [profile, subscription, branchRows, discountRows] = await Promise.all([
      this.getBillingProfile(businessId),
      this.getBusinessSubscription(businessId),
      this.dbService.db
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
        ),
      this.dbService.db
        .select()
        .from(subscriptionDiscounts)
        .where(
          and(
            eq(subscriptionDiscounts.businessId, businessId),
            eq(subscriptionDiscounts.isActive, true),
          ),
        )
        .orderBy(desc(subscriptionDiscounts.createdAt)),
    ]);

    const now = new Date();
    const activeDiscounts = discountRows.filter(
      (d) => !d.validUntil || d.validUntil > now,
    );

    const planPrice = subscription ? Number(subscription.plan.price) : 0;
    // First branch is included in the plan; each extra one is billed monthly.
    const extraBranches = Math.max(0, branchRows.length - 1);
    const extraBranchesTotal = extraBranches * EXTRA_BRANCH_PRICE;
    const subtotal = planPrice + extraBranchesTotal;
    const discountPercent = Math.min(
      100,
      activeDiscounts.reduce((sum, d) => sum + d.percent, 0),
    );
    const discountAmount = Math.round((subtotal * discountPercent) / 100);

    return {
      balance: profile ? Number(profile.balance) : 0,
      legalName: profile?.legalName ?? null,
      inn: profile?.inn ?? null,
      contractNumber: profile?.contractNumber ?? null,
      contractDate: profile?.contractDate ?? null,
      monthly: {
        planTier: subscription?.plan.tier ?? null,
        planName: subscription?.plan.name ?? null,
        planPrice,
        extraBranches,
        extraBranchPrice: EXTRA_BRANCH_PRICE,
        extraBranchesTotal,
        discountPercent,
        discountAmount,
        total: subtotal - discountAmount,
      },
      discounts: activeDiscounts.map((d) => ({
        id: d.id,
        label: d.label,
        percent: d.percent,
        validUntil: d.validUntil,
      })),
    };
  }

  private async getBillingProfile(
    businessId: string,
  ): Promise<BillingProfile | null> {
    const [profile] = await this.dbService.db
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.businessId, businessId))
      .limit(1);
    return profile || null;
  }

  /** Platform admin: upsert the legal details of a business's billing profile. */
  async updateBillingProfile(
    businessId: string,
    data: {
      legalName?: string;
      inn?: string;
      contractNumber?: string;
      contractDate?: string;
    },
  ): Promise<BillingProfile> {
    const set = {
      ...(data.legalName !== undefined && { legalName: data.legalName }),
      ...(data.inn !== undefined && { inn: data.inn }),
      ...(data.contractNumber !== undefined && {
        contractNumber: data.contractNumber,
      }),
      ...(data.contractDate !== undefined && {
        contractDate: new Date(data.contractDate),
      }),
      updatedAt: new Date(),
    };

    const [profile] = await this.dbService.db
      .insert(billingProfiles)
      .values({ businessId, ...set })
      .onConflictDoUpdate({ target: billingProfiles.businessId, set })
      .returning();

    await this.cache.del(CacheKeys.subscriptionBilling(businessId));
    return profile;
  }

  /** Platform admin: credit the prepaid balance (manual top-up until a payment provider is wired). */
  async topUpBalance(businessId: string, amount: number): Promise<BillingProfile> {
    const current = await this.getBillingProfile(businessId);
    const nextBalance = (current ? Number(current.balance) : 0) + amount;

    const [profile] = await this.dbService.db
      .insert(billingProfiles)
      .values({
        businessId,
        balance: nextBalance.toFixed(2),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: billingProfiles.businessId,
        set: { balance: nextBalance.toFixed(2), updatedAt: new Date() },
      })
      .returning();

    await this.cache.del(CacheKeys.subscriptionBilling(businessId));
    return profile;
  }

  /** Platform admin: grant a promo discount on the monthly bill. */
  async createDiscount(
    businessId: string,
    data: { label: string; percent: number; validUntil?: string },
  ): Promise<SubscriptionDiscount> {
    const { generateId } = await import('../utils/uuid');
    const [discount] = await this.dbService.db
      .insert(subscriptionDiscounts)
      .values({
        id: generateId(),
        businessId,
        label: data.label,
        percent: data.percent,
        validUntil: data.validUntil ? new Date(data.validUntil) : null,
      })
      .returning();

    await this.cache.del(CacheKeys.subscriptionBilling(businessId));
    return discount;
  }

  /** Platform admin: deactivate a discount. */
  async deleteDiscount(discountId: string): Promise<void> {
    const [discount] = await this.dbService.db
      .update(subscriptionDiscounts)
      .set({ isActive: false })
      .where(eq(subscriptionDiscounts.id, discountId))
      .returning();

    if (!discount) {
      throw new AppException(ErrorCode.NOT_FOUND, { discountId });
    }

    await this.cache.del(CacheKeys.subscriptionBilling(discount.businessId));
  }
}

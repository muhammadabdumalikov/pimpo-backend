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
import { eq, and, asc, desc, count } from 'drizzle-orm';
import { seedSubscriptionPlans } from './seed-plans';
import { CacheKeys, TTL } from '../cache/cache.util';
import {type Tier, gateTier, planBusinessType, sellsAiAddon, tierAtLeast} from './tier';
import {type BusinessType, isBusinessType} from '../common/business-type';
import {
  EXTRA_BRANCH_PRICE,
  asDate,
  computeMonthlyTotal,
  isPastEnd,
  isRestricted,
  normalizeDiscountInput,
  type DiscountInput,
  type DiscountLine,
  type MonthlyTotal,
  AI_ADDON_MONTHLY_ANSWERS,
  AI_ADDON_PRICE,
  YEARLY_DISCOUNT_PERCENT,
  asBillingCycle,
  cycleTotal,
  type BillingCycle,
} from '../billing/billing';
import { lockBillingProfile } from '../billing/billing-ledger';

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
    /** The AI bot add-on next month (0 when it is off). */
    aiAddon: number;
    discountPercent: number;
    discountAmount: number;
    /** discountAmount split by discount (billing.ts computeMonthlyTotal). */
    discountLines: DiscountLine[];
    total: number;
  };
  /** Monthly or yearly billing (OBUNA-TOLOV.md §9). */
  cycle: {
    /** What the next renewal charges for, as the owner set it. */
    wanted: BillingCycle;
    /** What the current period was paid for. */
    current: BillingCycle;
    /** Twelve months of `monthly.total` less the yearly discount. */
    yearlyTotal: number;
    discountPercent: number;
    /** What the next renewal takes: yearlyTotal or monthly.total. */
    renewalTotal: number;
  };
  discounts: DiscountView[];
};

/** The AI bot add-on as the shop sees it (ONLAYN-SOTUVCHI.md §10.1). */
export type AiAddonView = {
  /** The add-on is sold on this plan (the online plan). */
  available: boolean;
  /** The plan has the bot built in (Business+). */
  included: boolean;
  /** The bot may answer right now. */
  active: boolean;
  /** The owner keeps it for the next period (renewals bill it). */
  renews: boolean;
  /** End of the period it is part of; null when it is not. */
  until: string | null;
  price: number;
  monthlyLimit: number;
};

/** One discount as the shop page and the platform console list it. */
export type DiscountView = Pick<
  SubscriptionDiscount,
  | 'id'
  | 'label'
  | 'kind'
  | 'scope'
  | 'percent'
  | 'amount'
  | 'planTier'
  | 'validUntil'
> & {
  /** So'm it takes off the month right now; 0 when it has no effect. */
  saves: number;
};

/** POST /platform/businesses/:id/discounts/preview */
export type DiscountPreview = {
  current: MonthlyTotal;
  next: MonthlyTotal;
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

  async getAllPlans(
    // Shops see the shop plans, kitchens the kitchen plan (FASTFOOD.md Q14),
    // online sellers the online plan (ONLAYN-SOTUVCHI.md E3).
    businessType: BusinessType = 'retail',
  ): Promise<SubscriptionPlan[]> {
    const plans = await this.getAllActivePlans();
    return plans.filter((p) => planBusinessType(p.tier) === businessType);
  }

  private async getAllActivePlans(): Promise<SubscriptionPlan[]> {
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

  /**
   * True once a subscription's trial/paid window AND its grace period have
   * ended (OBUNA-TOLOV.md Q3): the plan keeps working for GRACE_DAYS after
   * end_date. endDate may arrive as an ISO string when the value came from the
   * Redis cache (JSON round-trip) — isRestricted normalises it, so this hot
   * tier-gating path never throws on a string.
   */
  private isExpired(sub: { endDate: Date | string | null }): boolean {
    return isRestricted(sub.endDate);
  }

  /**
   * The tier gating should treat this business as: the plan's tier while the
   * subscription is active and not past its grace period, otherwise the `free`
   * floor. This is the single source of truth the PlanTierGuard consults.
   */
  async getEffectiveTier(businessId: string): Promise<Tier> {
    const subscription = await this.getBusinessSubscription(businessId);
    if (!subscription || !subscription.isActive || this.isExpired(subscription)) {
      return 'free';
    }
    return gateTier(subscription.plan.tier);
  }

  /**
   * May the customer AI bot answer for this business (ONLAYN-SOTUVCHI.md E4):
   * Business+ has it in the plan; the online plan has it while the add-on is
   * part of the current period. The single gate for /assistant, /inbox and
   * the bot itself.
   */
  async aiAssistantAllowed(businessId: string): Promise<boolean> {
    const subscription = await this.getBusinessSubscription(businessId);
    if (!subscription || !subscription.isActive || this.isExpired(subscription)) {
      return false;
    }
    if (tierAtLeast(gateTier(subscription.plan.tier), 'proplus')) return true;
    return sellsAiAddon(subscription.plan.tier) && !!subscription.aiAddon;
  }

  /** The bot's monthly answer allowance: the add-on's 1 000, else the plan's. */
  async aiAssistantMonthlyLimit(
    businessId: string,
    planDefault: number,
  ): Promise<number> {
    const subscription = await this.getBusinessSubscription(businessId);
    return subscription && sellsAiAddon(subscription.plan.tier)
      ? AI_ADDON_MONTHLY_ANSWERS
      : planDefault;
  }

  /** The add-on block of GET /subscriptions/current (§10.1). */
  async aiAddonView(businessId: string): Promise<AiAddonView> {
    const [subscription, profile, active] = await Promise.all([
      this.getBusinessSubscription(businessId),
      this.getBillingProfile(businessId),
      this.aiAssistantAllowed(businessId),
    ]);
    const planTier = subscription?.plan.tier ?? null;
    const available = sellsAiAddon(planTier);
    return {
      available,
      included: !!planTier && tierAtLeast(gateTier(planTier), 'proplus'),
      active,
      renews: available && !!profile?.aiAddon,
      until:
        available && subscription?.aiAddon && subscription.endDate
          ? asDate(subscription.endDate).toISOString()
          : null,
      price: AI_ADDON_PRICE,
      monthlyLimit: AI_ADDON_MONTHLY_ANSWERS,
    };
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
        isTrial: businessSubscriptions.isTrial,
        pendingPlanId: businessSubscriptions.pendingPlanId,
        paidExtraBranches: businessSubscriptions.paidExtraBranches,
        aiAddon: businessSubscriptions.aiAddon,
        billingCycle: businessSubscriptions.billingCycle,
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

  /**
   * Platform admin: put the business on `planTier` with an explicit window end
   * (`null` = open-ended, which billing never touches). Self-serve changes go
   * through BillingService.changePlan instead and never come here — that is
   * what keeps a shop from granting itself an open-ended plan.
   */
  async updateBusinessSubscription(
    businessId: string,
    planTier: string,
    endDate: Date | null,
    opts: { isTrial?: boolean } = {},
  ): Promise<BusinessSubscription & { plan: SubscriptionPlan }> {
    // Get the plan
    const plan = await this.getPlanByTier(planTier);
    if (!plan) {
      throw new AppException(ErrorCode.SUBSCRIPTION_PLAN_TIER_NOT_FOUND, { tier: planTier });
    }

    const { generateId } = await import('../utils/uuid');
    await this.dbService.db.transaction(async (tx) => {
      // Same per-business lock as every billing write, so a renewal running
      // right now can't leave a second active row next to this one.
      await lockBillingProfile(tx, businessId);

      // Deactivate current subscription
      await tx
        .update(businessSubscriptions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(businessSubscriptions.businessId, businessId),
            eq(businessSubscriptions.isActive, true),
          ),
        );

      // Branches already open are part of what the admin granted, so only a
      // branch opened after this counts as a new paid seat.
      const [{ value: activeBranches }] = await tx
        .select({ value: count() })
        .from(branches)
        .where(
          and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
        );

      await tx.insert(businessSubscriptions).values({
        id: generateId(),
        businessId,
        planId: plan.id,
        isActive: true,
        endDate,
        isTrial: opts.isTrial ?? false,
        paidExtraBranches: Math.max(0, Number(activeBranches) - 1),
      });
    });

    // Drop the stale caches before re-reading so the fresh subscription is
    // returned (and re-cached) instead of the previous plan. Billing is derived
    // from the plan (monthly price/breakdown), so it must be invalidated too —
    // otherwise the status/admin pages keep showing the old plan's price.
    await this.invalidate(businessId);

    // Get subscription with plan
    const result = await this.getBusinessSubscription(businessId);
    if (!result) {
      throw new AppException(ErrorCode.SUBSCRIPTION_CREATE_FAILED);
    }

    return result;
  }

  /** Drop every cached view derived from the subscription or the balance. */
  async invalidate(businessId: string): Promise<void> {
    await Promise.all([
      this.cache.del(CacheKeys.subscriptionCurrent(businessId)),
      this.cache.del(CacheKeys.subscriptionBilling(businessId)),
    ]);
  }

  /**
   * GET /subscriptions/current — also the `subscription` the self-serve plan
   * change returns. The plan reads as active through the grace period
   * (`inGrace`), and as the free floor once that is over.
   */
  async getCurrentView(businessId: string) {
    const subscription = await this.getBusinessSubscription(businessId);

    // No subscription, or the window and its grace have ended → report the
    // internal free floor so the client gates the UI down accordingly.
    if (!subscription || !subscription.isActive || this.isExpired(subscription)) {
      const freePlan = await this.getPlanByTier('free');
      return {
        plan: freePlan,
        tier: 'free',
        aiAddon: await this.aiAddonView(businessId),
        isActive: true,
        isExpired: !!subscription,
        isTrial: false,
        inGrace: false,
        pendingPlan: null,
        endDate: subscription?.endDate ?? null,
      };
    }

    const pending = subscription.pendingPlanId
      ? await this.getPlanById(subscription.pendingPlanId)
      : null;

    return {
      plan: subscription.plan,
      // What the client gates on: a kitchen plan reads as the tier it gates
      // like ('food' → 'basic'); the plan itself is in `planTier`.
      tier: gateTier(subscription.plan.tier),
      planTier: subscription.plan.tier,
      aiAddon: await this.aiAddonView(businessId),
      isActive: subscription.isActive,
      // From the column now, not "has a future endDate" — a paid month has one too.
      isTrial: subscription.isTrial ?? false,
      inGrace: isPastEnd(subscription.endDate),
      pendingPlan: pending
        ? { tier: pending.tier, name: pending.name, price: Number(pending.price) }
        : null,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
    };
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

    await this.invalidate(businessId);
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

  /** What the monthly total is computed from: plan, branches, live discounts. */
  private async billingInputs(businessId: string) {
    const [subscription, branchRows, discountRows, profile] = await Promise.all([
      this.getBusinessSubscription(businessId),
      this.dbService.db
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
        ),
      // Oldest first: the order the breakdown lists them in.
      this.dbService.db
        .select()
        .from(subscriptionDiscounts)
        .where(
          and(
            eq(subscriptionDiscounts.businessId, businessId),
            eq(subscriptionDiscounts.isActive, true),
          ),
        )
        .orderBy(asc(subscriptionDiscounts.createdAt)),
      this.getBillingProfile(businessId),
    ]);

    const now = new Date();
    return {
      now,
      subscription,
      profile,
      // The next renewal bills the add-on while the owner keeps it on (E4).
      aiAddon:
        !!profile?.aiAddon && sellsAiAddon(subscription?.plan.tier ?? null),
      planPrice: subscription ? Number(subscription.plan.price) : 0,
      planTier: subscription?.plan.tier ?? null,
      // First branch is included in the plan; each extra one is billed monthly.
      extraBranches: branchRows.length - 1,
      // Not yet expired. A discount tied to another plan stays listed (it
      // comes back if the shop returns to that plan) but takes nothing off.
      activeDiscounts: discountRows.filter(
        (d) => !d.validUntil || asDate(d.validUntil) > now,
      ),
    };
  }

  private async fetchBillingInfo(businessId: string): Promise<BillingInfo> {
    const inputs = await this.billingInputs(businessId);
    const { subscription, activeDiscounts, now, profile } = inputs;

    const monthly = computeMonthlyTotal({
      planPrice: inputs.planPrice,
      planTier: inputs.planTier,
      extraBranches: inputs.extraBranches,
      aiAddon: inputs.aiAddon,
      discounts: activeDiscounts,
      now,
    });
    const saves = new Map(monthly.discountLines.map((l) => [l.id, l.amount]));

    return {
      balance: profile ? Number(profile.balance) : 0,
      legalName: profile?.legalName ?? null,
      inn: profile?.inn ?? null,
      contractNumber: profile?.contractNumber ?? null,
      contractDate: profile?.contractDate ?? null,
      monthly: {
        planTier: subscription?.plan.tier ?? null,
        planName: subscription?.plan.name ?? null,
        planPrice: monthly.planPrice,
        extraBranches: monthly.extraBranches,
        extraBranchPrice: EXTRA_BRANCH_PRICE,
        extraBranchesTotal: monthly.extraBranchesTotal,
        aiAddon: monthly.aiAddon,
        discountPercent: monthly.discountPercent,
        discountAmount: monthly.discountAmount,
        discountLines: monthly.discountLines,
        total: monthly.total,
      },
      cycle: {
        wanted: asBillingCycle(profile?.billingCycle),
        current: asBillingCycle(subscription?.billingCycle),
        yearlyTotal: cycleTotal(monthly.total, 'year'),
        discountPercent: YEARLY_DISCOUNT_PERCENT,
        renewalTotal: cycleTotal(
          monthly.total,
          asBillingCycle(profile?.billingCycle),
        ),
      },
      discounts: activeDiscounts.map((d) => ({
        id: d.id,
        label: d.label,
        kind: d.kind,
        scope: d.scope,
        percent: d.percent,
        amount: d.amount,
        planTier: d.planTier,
        validUntil: d.validUntil,
        saves: saves.get(d.id) ?? 0,
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

  /**
   * The row a discount request becomes, or VALIDATION_ERROR naming the field.
   * A special price for the plan is tied to a plan tier — the one asked for,
   * else the shop's current plan.
   */
  private async resolveDiscount(
    data: DiscountInput,
    currentPlanTier: string | null,
  ) {
    const result = normalizeDiscountInput(data, currentPlanTier);
    if ('error' in result) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        field: result.error,
      });
    }
    if (result.planTier) {
      const [plan] = await this.dbService.db
        .select({ id: subscriptionPlans.id })
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.tier, result.planTier))
        .limit(1);
      if (!plan) {
        throw new AppException(ErrorCode.SUBSCRIPTION_PLAN_TIER_NOT_FOUND, {
          tier: result.planTier,
        });
      }
    }
    return result;
  }

  /** Platform admin: grant a discount on the monthly bill. */
  async createDiscount(
    businessId: string,
    data: DiscountInput & { label: string },
  ): Promise<SubscriptionDiscount> {
    const { generateId } = await import('../utils/uuid');
    const subscription = await this.getBusinessSubscription(businessId);
    const term = await this.resolveDiscount(
      data,
      subscription?.plan.tier ?? null,
    );
    const [discount] = await this.dbService.db
      .insert(subscriptionDiscounts)
      .values({
        id: generateId(),
        businessId,
        label: data.label,
        ...term,
      })
      .returning();

    await this.cache.del(CacheKeys.subscriptionBilling(businessId));
    return discount;
  }

  /**
   * Platform admin: what the month would cost with one more discount, next to
   * what it costs now. Nothing is written.
   */
  async previewDiscount(
    businessId: string,
    data: DiscountInput,
  ): Promise<DiscountPreview> {
    const inputs = await this.billingInputs(businessId);
    const term = await this.resolveDiscount(data, inputs.planTier);
    const price = (discounts: Parameters<typeof computeMonthlyTotal>[0]['discounts']) =>
      computeMonthlyTotal({
        planPrice: inputs.planPrice,
        planTier: inputs.planTier,
        extraBranches: inputs.extraBranches,
        aiAddon: inputs.aiAddon,
        discounts,
        now: inputs.now,
      });
    return {
      current: price(inputs.activeDiscounts),
      next: price([
        ...inputs.activeDiscounts,
        { id: null, label: null, ...term },
      ]),
    };
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

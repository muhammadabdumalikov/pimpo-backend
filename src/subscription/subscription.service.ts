import { Injectable, NotFoundException, ConflictException, OnModuleInit, Inject } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { DatabaseService } from '../database/database.service';
import {
  subscriptionPlans,
  businessSubscriptions,
  type SubscriptionPlan,
  type BusinessSubscription,
} from '../database/schema';
import { eq, and, desc } from 'drizzle-orm';
import { seedSubscriptionPlans } from './seed-plans';
import { CacheKeys, TTL } from '../cache/cache.util';

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
    // invalidated on create/update/delete of a plan.
    return this.cache.wrap(
      CacheKeys.plansAll(),
      () =>
        this.dbService.db
          .select()
          .from(subscriptionPlans)
          .orderBy(subscriptionPlans.price),
      TTL.PLANS,
    );
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
      throw new NotFoundException(`Subscription plan with tier ${planTier} not found`);
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
      throw new NotFoundException('Failed to create subscription');
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

    if (!subscription) {
      // Default to free plan limits
      return {
        debtsLimit: 20,
        productsLimit: 100,
        usersLimit: 1,
        branchesLimit: 1,
      };
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
      throw new ConflictException(`Plan with tier ${data.tier} already exists`);
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
      throw new NotFoundException(`Plan with id ${planId} not found`);
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
      throw new NotFoundException(`Plan with id ${planId} not found`);
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
}

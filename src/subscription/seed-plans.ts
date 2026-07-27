import { DatabaseService } from '../database/database.service';
import { subscriptionPlans } from '../database/schema';
import { generateId } from '../utils/uuid';
import { eq } from 'drizzle-orm';

export async function seedSubscriptionPlans(dbService: DatabaseService) {
  // Prices are in UZS (Uzbekistani som). Limits: null = unlimited.
  //
  // There is no purchasable "free" plan on the landing anymore — new businesses
  // get a 1-month Standart (basic) trial instead (see BusinessService.create).
  // The `free` row is kept but DEACTIVATED: it is the internal "no active plan /
  // trial expired" floor that gating falls back to, and never appears in the
  // public plan catalogue (getAllPlans filters isActive).
  const plans = [
    {
      id: generateId(),
      tier: 'free',
      name: 'Free',
      description: 'Trial expired / no active plan (internal floor)',
      price: '0',
      isActive: false,
      debtsLimit: 20,
      productsLimit: 100,
      usersLimit: 1,
      branchesLimit: 1,
    },
    {
      id: generateId(),
      tier: 'basic',
      name: 'Standard',
      description: 'For a single shop',
      price: '119000',
      isActive: true,
      debtsLimit: null,
      productsLimit: null,
      usersLimit: 10,
      // Main shop + 2. Business is the multi-branch plan, so Standart stops
      // short of a real network — a 4th point means moving up. Enforced on
      // branch CREATE only (branch.service.ts), so a shop that already has more
      // keeps them and simply cannot add another.
      branchesLimit: 3,
    },
    {
      id: generateId(),
      tier: 'pro',
      name: 'Business',
      description: 'For multi-branch networks',
      price: '299000',
      isActive: true,
      debtsLimit: null,
      productsLimit: null,
      usersLimit: 20,
      branchesLimit: 6,
    },
    {
      id: generateId(),
      tier: 'proplus',
      name: 'Business+',
      description: 'For large retail networks',
      // Business+ is a pure scale ceiling (unlimited branches, 50 users) — it
      // carries no exclusive feature now that multi-branch analytics moved to
      // `pro`. 499k could not be defended on scale alone; revisit if offline
      // mode ships and lands here.
      price: '399000',
      isActive: true,
      debtsLimit: null,
      productsLimit: null,
      usersLimit: 50,
      branchesLimit: null,
    },
  ];

  for (const plan of plans) {
    const existing = await dbService.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.tier, plan.tier))
      .limit(1);

    if (existing.length === 0) {
      await dbService.db.insert(subscriptionPlans).values(plan);
    } else {
      // Keep existing rows in sync with the latest pricing/limits/status.
      await dbService.db
        .update(subscriptionPlans)
        .set({
          price: plan.price,
          isActive: plan.isActive,
          debtsLimit: plan.debtsLimit,
          productsLimit: plan.productsLimit,
          usersLimit: plan.usersLimit,
          branchesLimit: plan.branchesLimit,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionPlans.tier, plan.tier));
    }
  }
}

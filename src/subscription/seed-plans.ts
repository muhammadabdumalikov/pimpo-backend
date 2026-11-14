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
      // Business+ is the scale ceiling (unlimited branches, 50 users) plus the
      // customer AI bot and its Murojaatlar inbox, which are exclusive to it
      // (@MinTier('proplus') on /assistant and /inbox). That exclusive is what
      // carries 499k; on scale alone the plan was 399k. Renewals read this
      // price live (billing.service tryRenew), so a change here reaches every
      // existing Business+ shop at its next renewal.
      price: '499000',
      isActive: true,
      debtsLimit: null,
      productsLimit: null,
      usersLimit: 50,
      branchesLimit: null,
    },
    {
      id: generateId(),
      // The fast-food kitchen plan (FASTFOOD.md Q14–Q15): one point, sold to
      // food businesses only, gating like `basic` (tier.ts gateTier). Cards
      // count dishes, semi-finished items and ingredients alike.
      tier: 'food',
      name: 'Fast-food',
      description: 'For a single fast-food kitchen',
      price: '249000',
      isActive: true,
      debtsLimit: null,
      productsLimit: 300,
      usersLimit: 10,
      branchesLimit: 1,
    },
    {
      id: generateId(),
      // The online seller plan (ONLAYN-SOTUVCHI.md Q10, E2): a one-person
      // seller on Instagram/Telegram — no shop, no till. Sold to online
      // businesses only; gates like `pro` (the storefront is a pro module),
      // the AI bot is a +149 000 add-on (billing.ts AI_ADDON_PRICE).
      tier: 'online',
      name: 'Online seller',
      description: 'For a seller on Instagram and Telegram',
      price: '199000',
      isActive: true,
      debtsLimit: null,
      productsLimit: null,
      usersLimit: 1,
      branchesLimit: 1,
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
      // Keep existing rows in sync with the latest names/pricing/limits/status.
      // The name too: it reaches the platform console, billing ledger and
      // Telegram billing messages, and old rows still said "Basic"/"Pro".
      await dbService.db
        .update(subscriptionPlans)
        .set({
          name: plan.name,
          description: plan.description,
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

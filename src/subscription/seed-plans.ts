import { DatabaseService } from '../database/database.service';
import { subscriptionPlans } from '../database/schema';
import { generateId } from '../utils/uuid';
import { eq } from 'drizzle-orm';

export async function seedSubscriptionPlans(dbService: DatabaseService) {
  // Prices are in UZS (Uzbekistani som). Limits: null = unlimited.
  const plans = [
    {
      id: generateId(),
      tier: 'free',
      name: 'Free',
      description: 'Perfect for getting started',
      price: '0',
      isActive: true,
      debtsLimit: 20,
      productsLimit: 100,
      usersLimit: 1,
      branchesLimit: 1,
    },
    {
      id: generateId(),
      tier: 'basic',
      name: 'Standard',
      description: 'For growing shops',
      price: '119000',
      isActive: true,
      debtsLimit: null,
      productsLimit: null,
      usersLimit: 4,
      branchesLimit: 4,
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
      usersLimit: 10,
      branchesLimit: 6,
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
      // Keep existing rows in sync with the latest pricing/limits.
      await dbService.db
        .update(subscriptionPlans)
        .set({
          price: plan.price,
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

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
      productsLimit: 150,
    },
    {
      id: generateId(),
      tier: 'basic',
      name: 'Basic',
      description: 'For small businesses',
      price: '99000',
      isActive: true,
      debtsLimit: null,
      productsLimit: 3000,
    },
    {
      id: generateId(),
      tier: 'pro',
      name: 'Pro',
      description: 'For growing businesses',
      price: '249000',
      isActive: true,
      debtsLimit: null,
      productsLimit: null,
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
          updatedAt: new Date(),
        })
        .where(eq(subscriptionPlans.tier, plan.tier));
    }
  }
}

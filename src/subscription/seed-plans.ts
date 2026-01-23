import { DatabaseService } from '../database/database.service';
import { subscriptionPlans } from '../database/schema';
import { generateId } from '../utils/uuid';
import { eq } from 'drizzle-orm';

export async function seedSubscriptionPlans(dbService: DatabaseService) {
  const plans = [
    {
      id: generateId(),
      tier: 'free',
      name: 'Free',
      description: 'Perfect for getting started',
      price: '0',
      isActive: true,
      debtsLimit: 20,
      productsLimit: 20,
    },
    {
      id: generateId(),
      tier: 'basic',
      name: 'Basic',
      description: 'For small businesses',
      price: '29',
      isActive: true,
      debtsLimit: null,
      productsLimit: null,
    },
    {
      id: generateId(),
      tier: 'pro',
      name: 'Pro',
      description: 'For growing businesses',
      price: '99',
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
    }
  }
}

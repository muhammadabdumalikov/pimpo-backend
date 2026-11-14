/**
 * Subscription tier ordering, shared by the plan gating guard and the
 * subscription service. Higher rank = more capable plan.
 *
 * `free` is the internal floor (no purchasable plan on the landing): a business
 * lands here when it never subscribed or its trial expired.
 */
export type Tier = 'free' | 'basic' | 'pro' | 'proplus';

export const TIER_RANK: Record<Tier, number> = {
  free: 0,
  basic: 1,
  pro: 2,
  proplus: 3,
};

/** True when `tier` is at least `min` in the ordering above. */
export function tierAtLeast(tier: string, min: Tier): boolean {
  const rank = TIER_RANK[tier as Tier];
  return rank !== undefined && rank >= TIER_RANK[min];
}

/**
 * A plan row's tier as stored, which may also be a business-type plan: 'food'
 * is the fast-food kitchen plan (FASTFOOD.md Q14–Q15, 249k), 'online' the
 * online seller plan (ONLAYN-SOTUVCHI.md E2, 199k). Such a plan has its own
 * price and limits but GATES like a regular tier — every @MinTier check reads
 * it through gateTier(). 'online' gates like 'pro' because the storefront is a
 * pro module; its 1 branch / 1 user limits keep it a one-person plan.
 */
export type PlanTier = Tier | 'food' | 'online';

const PLAN_TIER_GATE: Record<string, Tier> = {food: 'basic', online: 'pro'};

/** The tier a stored plan tier gates as; unknown values fall to the floor. */
export function gateTier(planTier: string | null | undefined): Tier {
  if (!planTier) return 'free';
  if (TIER_RANK[planTier as Tier] !== undefined) return planTier as Tier;
  return PLAN_TIER_GATE[planTier] ?? 'free';
}

/** Plans sold to food businesses only; every other plan is the shop's. */
export function isFoodPlanTier(planTier: string): boolean {
  return planTier === 'food';
}

/** The business type a plan is sold to: 'food', 'online' or the shops. */
export function planBusinessType(
  planTier: string,
): 'retail' | 'food' | 'online' {
  return planTier === 'food' || planTier === 'online' ? planTier : 'retail';
}

/** The plan the AI bot add-on is sold on (ONLAYN-SOTUVCHI.md D10). */
export function sellsAiAddon(planTier: string | null | undefined): boolean {
  return planTier === 'online';
}

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

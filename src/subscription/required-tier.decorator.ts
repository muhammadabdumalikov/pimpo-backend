import { SetMetadata } from '@nestjs/common';
import type { Tier } from './tier';

export const MIN_TIER_KEY = 'minTier';

/**
 * Marks a route (or a whole controller) as requiring at least `tier`. Enforced
 * by PlanTierGuard, which must run after JwtAuthGuard so the business is known.
 *
 * Usage:
 *   @MinTier('pro')
 *   @Get('pnl') ...
 */
export const MinTier = (tier: Tier) => SetMetadata(MIN_TIER_KEY, tier);

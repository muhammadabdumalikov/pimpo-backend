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

export const AI_BOT_PLAN_KEY = 'orAiBotPlan';

/**
 * Lets a plan that carries the customer AI bot stand in for the @MinTier on
 * this route or controller (ONLAYN-SOTUVCHI.md §11): the online seller plan
 * passes like Business+ does. Used on /assistant and /inbox.
 */
export const OrAiBotPlan = () => SetMetadata(AI_BOT_PLAN_KEY, true);

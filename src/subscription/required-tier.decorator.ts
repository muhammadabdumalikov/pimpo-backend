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

export const AI_ADDON_KEY = 'orAiAddon';

/**
 * Lets the AI bot add-on stand in for the @MinTier on this route or controller
 * (ONLAYN-SOTUVCHI.md E4): the online plan with the add-on in its current
 * period passes like Business+ does. Used on /assistant and /inbox.
 */
export const OrAiAddon = () => SetMetadata(AI_ADDON_KEY, true);

import {SetMetadata} from '@nestjs/common';
import type {FeatureKey} from './feature.catalog';

export const REQUIRED_FEATURE_KEY = 'requiredFeature';

/**
 * Marks a route (or a whole controller) as part of a feature that is rolling
 * out per do'kon. Enforced by FeatureGuard, which must run after JwtAuthGuard
 * so the business is known.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, FeatureGuard)
 *   @RequireFeature('loyalty_checkout')
 *   @Post('redeem') ...
 */
export const RequireFeature = (key: FeatureKey) =>
  SetMetadata(REQUIRED_FEATURE_KEY, key);

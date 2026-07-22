import {
  Injectable,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { IBusiness } from '../business/types';
import { SubscriptionService } from './subscription.service';
import { MIN_TIER_KEY } from './required-tier.decorator';
import { TIER_RANK, type Tier } from './tier';

/**
 * Enforces the minimum subscription tier declared with @MinTier() on a route or
 * controller. Method metadata wins over class metadata. Routes without the
 * decorator are unrestricted (still behind JwtAuthGuard).
 *
 * Must be listed AFTER JwtAuthGuard in @UseGuards so `request.user` (the owning
 * business) is already resolved.
 */
@Injectable()
export class PlanTierGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const minTier = this.reflector.getAllAndOverride<Tier | undefined>(
      MIN_TIER_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!minTier) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: IBusiness }>();
    const business = request.user;
    if (!business?.id) {
      throw new AppException(ErrorCode.NO_TOKEN);
    }

    const tier = await this.subscriptionService.getEffectiveTier(business.id);
    if (TIER_RANK[tier] < TIER_RANK[minTier]) {
      throw new AppException(ErrorCode.PLAN_UPGRADE_REQUIRED, {
        required: minTier,
        current: tier,
      });
    }
    return true;
  }
}

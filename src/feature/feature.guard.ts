import {Injectable, CanActivate, ExecutionContext} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {Request} from 'express';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {IBusiness} from '../business/types';
import {FeatureService} from './feature.service';
import {REQUIRED_FEATURE_KEY} from './require-feature.decorator';

/**
 * Enforces the feature flag declared with @RequireFeature() on a route or
 * controller. Method metadata wins over class metadata. Routes without the
 * decorator are unrestricted.
 *
 * Hiding the menu item is not enough — the endpoint itself refuses a shop the
 * flag is off for. Must be listed AFTER JwtAuthGuard in @UseGuards.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly featureService: FeatureService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!key) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & {user?: IBusiness}>();
    const business = request.user;
    if (!business?.id) {
      throw new AppException(ErrorCode.NO_TOKEN);
    }

    await this.featureService.assertOn(business.id, key);
    return true;
  }
}

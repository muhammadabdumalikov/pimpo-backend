import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {Request} from 'express';
import {Observable} from 'rxjs';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {IAccount, IBusiness} from '../business/types';
import {BranchScopeService} from '../permission/branch-scope.service';
import {ALLOW_WHEN_LOCKED_KEY} from './allow-when-locked.decorator';
import {SubscriptionService} from './subscription.service';

/**
 * Closes the whole shop once its subscription ended and the grace period is
 * over: every signed-in route answers SUBSCRIPTION_LOCKED (402), the till
 * included, except the ones marked @AllowWhenLocked().
 *
 * A staff account pinned to one store that is closed for non-payment
 * (FILIAL-OBUNA.md Q3) is shut out the same way, with BRANCH_LOCKED; the
 * owner and staff who see every store keep working.
 *
 * Global and run after the guards, so `request.user` is the business that
 * JwtAuthGuard resolved. Public routes (sign-in, the storefront, webhooks) and
 * the platform console never set it and pass untouched.
 */
@Injectable()
export class SubscriptionLockInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptions: SubscriptionService,
    @Optional() private readonly scopes?: BranchScopeService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context
      .switchToHttp()
      .getRequest<Request & {user?: IBusiness; account?: IAccount}>();
    const business = request.user;
    if (!business?.id) return next.handle();

    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_WHEN_LOCKED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return next.handle();

    if (await this.subscriptions.isLocked(business.id)) {
      throw new AppException(ErrorCode.SUBSCRIPTION_LOCKED);
    }
    const account = request.account;
    if (account?.type === 'staff' && this.scopes) {
      // Cheap first: most shops have no closed store at all.
      const closed = await this.subscriptions.closedBranchIds(business.id);
      if (closed.length) {
        const pinned = await this.scopes.scopeFor(account);
        if (pinned && closed.includes(pinned)) {
          throw new AppException(ErrorCode.BRANCH_LOCKED);
        }
      }
    }
    return next.handle();
  }
}

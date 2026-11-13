import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {Request} from 'express';
import {Observable} from 'rxjs';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {IAccount} from '../business/types';
import {BRANCH_SCOPE_KEY, BranchScopeMode} from './branch-scope.decorator';
import {BranchScopeService} from './branch-scope.service';

/**
 * Pins branch-scoped reads to the acting account's branch (see BranchScope).
 *
 * Runs after the guards, so `request.account` is set by JwtAuthGuard. Express
 * 5 makes `req.query` a getter that re-parses the URL, so the narrowed query
 * is installed as an own property that shadows it for the rest of the request
 * — the @Query() params Nest resolves next read from it.
 */
@Injectable()
export class BranchScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly scopes: BranchScopeService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const mode = this.reflector.getAllAndOverride<BranchScopeMode | undefined>(
      BRANCH_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!mode) return next.handle();

    const request = context
      .switchToHttp()
      .getRequest<Request & {account?: IAccount}>();
    const account = request.account;
    if (!account) return next.handle();

    const pinned = await this.scopes.scopeFor(account);
    if (pinned === null) return next.handle();

    if (mode === 'business') {
      throw new AppException(ErrorCode.PERMISSION_DENIED, {
        required: 'branch:all',
      });
    }

    const query = {
      ...(request.query as Record<string, unknown>),
      branchId: pinned,
    };
    Object.defineProperty(request, 'query', {
      value: query,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return next.handle();
  }
}

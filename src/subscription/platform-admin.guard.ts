import {
  Injectable,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { Request } from 'express';

/**
 * Guards platform-level operations (e.g. editing the global subscription plans
 * that every business shares). Requires the `X-Admin-Token` header to match the
 * `ADMIN_API_TOKEN` env var.
 *
 * Deny-by-default: if `ADMIN_API_TOKEN` is not configured, access is refused —
 * so these endpoints are never silently open to ordinary business accounts.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-admin-token'];
    const expected = process.env.ADMIN_API_TOKEN;

    if (!expected || provided !== expected) {
      throw new AppException(ErrorCode.PLATFORM_ADMIN_REQUIRED);
    }
    return true;
  }
}

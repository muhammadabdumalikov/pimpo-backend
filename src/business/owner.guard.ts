import {
  Injectable,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { Request } from 'express';
import { IAccount } from './types';

/**
 * Allows the request only when the acting account is the business owner
 * (not a staff member). Must run after JwtAuthGuard, which populates
 * request.account.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { account?: IAccount }>();

    if (request.account?.type !== 'business') {
      throw new AppException(ErrorCode.OWNER_ONLY);
    }
    return true;
  }
}

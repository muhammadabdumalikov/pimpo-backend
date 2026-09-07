import {
  Injectable,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {Request} from 'express';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {IAccount} from '../business/types';
import {PERMISSIONS_KEY} from './permission.decorator';
import {PermissionService} from './permission.service';

/**
 * Enforces @RequirePermission() on a route or controller. Method metadata wins
 * over class metadata. A route without the decorator is unrestricted (still
 * behind JwtAuthGuard) and costs NOTHING — the guard returns before touching
 * the cache. The owner short-circuits too, so dashboard traffic is free.
 *
 * Must be listed AFTER JwtAuthGuard in @UseGuards so `request.account` exists.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionService: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & {account?: IAccount}>();
    const account = request.account;
    if (!account) throw new AppException(ErrorCode.NO_TOKEN);

    await this.permissionService.assert(account, ...required);
    return true;
  }
}

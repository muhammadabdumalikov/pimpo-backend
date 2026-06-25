import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { IAccount } from '../types';

/**
 * Extract the acting account (owner or staff) from the request.
 * Usage: @CurrentAccount() account: IAccount
 */
export const CurrentAccount = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): IAccount => {
    const request = ctx.switchToHttp().getRequest();
    return request.account as IAccount;
  },
);

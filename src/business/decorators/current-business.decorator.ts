import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { IBusiness } from '../types';

/**
 * Custom decorator to extract the current authenticated business from the request
 * Usage: @CurrentBusiness() business: IBusiness
 */
export const CurrentBusiness = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): IBusiness => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as IBusiness;
  },
);

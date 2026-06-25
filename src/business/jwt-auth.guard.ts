import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { BusinessService } from './business.service';
import { IBusiness, IAccount } from './types';

export interface JwtPayload {
  sub: string; // user id — business.id for owner, staff.id for staff
  businessId: string; // always the owning business id (used for scoping)
  login: string;
  type: 'business' | 'staff';
  roleId?: string; // staff only
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly businessService: BusinessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
      });

      // Always resolve the owning business so every @CurrentBusiness()-scoped
      // controller keeps working unchanged for staff tokens too. Older tokens
      // (issued before staff support) only carry `sub`, so fall back to it.
      const businessId = payload.businessId || payload.sub;
      const business = await this.businessService.findById(businessId);

      if (!business || !business.isActive) {
        throw new UnauthorizedException('Business not found or inactive');
      }

      // Remove password and attach business + account info to request
      const { password: _, ...businessWithoutPassword } = business;
      const req = request as Request & { user: IBusiness; account: IAccount };
      req.user = businessWithoutPassword;
      req.account = {
        type: payload.type || 'business',
        id: payload.sub,
        roleId: payload.roleId,
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Invalid token');
    }

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}

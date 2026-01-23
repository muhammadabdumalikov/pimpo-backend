import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { BusinessService } from './business.service';
import { IBusiness } from './types';

export interface JwtPayload {
  sub: string;
  login: string;
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

      const business = await this.businessService.findById(payload.sub);

      if (!business || !business.isActive) {
        throw new UnauthorizedException('Business not found or inactive');
      }

      // Remove password and attach business to request
      const { password: _, ...businessWithoutPassword } = business;
      (request as Request & { user: IBusiness }).user = businessWithoutPassword;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}

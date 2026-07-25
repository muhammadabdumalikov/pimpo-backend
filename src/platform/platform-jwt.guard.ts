import {
  Injectable,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PLATFORM_ROLE, type PlatformJwtPayload } from './platform-auth.service';

/**
 * Gates every /platform data endpoint. Requires a Bearer JWT issued by
 * PlatformAuthService (login/password → token) carrying `role: platform-admin`.
 *
 * The token shares the tenant JWT secret but is safely distinct: a business/staff
 * token has no `platform-admin` role, so it can't reach these endpoints; and a
 * platform token has no businessId, so it can't pass the tenant JwtAuthGuard.
 */
@Injectable()
export class PlatformJwtGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) {
      throw new AppException(ErrorCode.NO_TOKEN);
    }

    try {
      const payload = await this.jwtService.verifyAsync<PlatformJwtPayload>(
        token,
        {
          secret:
            process.env.JWT_SECRET || 'your-secret-key-change-in-production',
        },
      );
      if (payload.role !== PLATFORM_ROLE) {
        throw new AppException(ErrorCode.PLATFORM_ADMIN_REQUIRED);
      }
    } catch (err) {
      if (err instanceof AppException) throw err;
      throw new AppException(ErrorCode.INVALID_TOKEN);
    }

    return true;
  }
}

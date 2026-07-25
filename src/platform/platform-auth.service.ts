import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';

/** Marker role carried by a platform-admin token — checked by PlatformJwtGuard. */
export const PLATFORM_ROLE = 'platform-admin';

export interface PlatformJwtPayload {
  role: typeof PLATFORM_ROLE;
}

/**
 * Static platform-admin authentication (temporary — no user table yet).
 *
 * Credentials are checked against PLATFORM_ADMIN_LOGIN / PLATFORM_ADMIN_PASSWORD
 * from the environment. On success the caller gets a signed JWT (same secret as
 * the tenant tokens, but carrying `role: platform-admin`), which PlatformJwtGuard
 * validates on every protected platform endpoint. Login/password are exchanged
 * once for this token, so the password is never re-sent per request.
 *
 * Deny-by-default: if either env var is unset, login always fails.
 */
@Injectable()
export class PlatformAuthService {
  constructor(private readonly jwtService: JwtService) {}

  async login(login: string, password: string): Promise<{ token: string }> {
    const expectedLogin = process.env.PLATFORM_ADMIN_LOGIN;
    const expectedPassword = process.env.PLATFORM_ADMIN_PASSWORD;

    if (!expectedLogin || !expectedPassword) {
      // Not configured → refuse rather than leak that state.
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
    }

    if (login !== expectedLogin || password !== expectedPassword) {
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
    }

    const payload: PlatformJwtPayload = { role: PLATFORM_ROLE };
    const token = await this.jwtService.signAsync(payload);
    return { token };
  }
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/**
 * Static platform-admin login. Credentials are checked against the
 * PLATFORM_ADMIN_LOGIN / PLATFORM_ADMIN_PASSWORD env vars (see PlatformAuthService).
 * On success the client receives the platform admin token to send as
 * `X-Admin-Token` on every subsequent platform request.
 */
export class PlatformLoginDto {
  @ApiProperty({ description: 'Platform admin login', example: 'admin' })
  @IsString()
  @IsNotEmpty()
  login: string;

  @ApiProperty({ description: 'Platform admin password', example: 'secret' })
  @IsString()
  @IsNotEmpty()
  password: string;
}

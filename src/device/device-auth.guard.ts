import {
  CanActivate,
  ExecutionContext,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import type {Device} from '../database/schema';
import {DeviceService} from './device.service';
import type {DeviceRequest} from './device.types';

function header(req: DeviceRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Authenticates the desktop till itself (not a cashier) by its
 * `X-Device-Token`, and attaches the device row to the request. Cashier
 * actions keep using the ordinary staff JWT that a PIN sign-in issues.
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly deviceService: DeviceService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<DeviceRequest>();
    const token = header(req, 'x-device-token');
    if (!token) throw new AppException(ErrorCode.DEVICE_TOKEN_MISSING);
    req.device = await this.deviceService.authenticate(
      token,
      header(req, 'x-desktop-version'),
    );
    return true;
  }
}

/** The device DeviceAuthGuard resolved. Usage: @CurrentDevice() device: Device */
export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Device =>
    ctx.switchToHttp().getRequest<DeviceRequest>().device,
);

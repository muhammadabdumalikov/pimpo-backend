import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {IAccount, IBusiness} from '../business/types';
import type {Device} from '../database/schema';
import {RequirePermission} from '../permission/permission.decorator';
import {PermissionsGuard} from '../permission/permissions.guard';
import {CurrentDevice, DeviceAuthGuard} from './device-auth.guard';
import {DeviceService} from './device.service';
import {BindDeviceDto} from './dto/bind-device.dto';
import {DeviceSessionDto} from './dto/device-session.dto';

/**
 * Desktop till devices (pimpo-desktop, DESKTOP.md). Two audiences:
 *  • the dashboard / an admin on the till — JWT + `register:manage`;
 *  • the till itself — `X-Device-Token` (the `me` routes).
 */
@ApiTags('devices')
@Controller('devices')
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('register:manage')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Bind this PC to a register; returns the device token once',
  })
  bind(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: BindDeviceDto,
  ) {
    return this.deviceService.bind(business.id, account, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('register:manage')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({summary: 'List bound till devices'})
  list(@CurrentBusiness() business: IBusiness) {
    return this.deviceService.list(business.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('register:manage')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({summary: 'Unlink a till device'})
  async revoke(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.deviceService.revoke(business.id, id);
  }

  @Get('me')
  @UseGuards(DeviceAuthGuard)
  @ApiOperation({
    summary: 'Till start-up status: binding, tier, offline flag, min version',
  })
  me(@CurrentDevice() device: Device) {
    return this.deviceService.status(device);
  }

  @Get('me/staff')
  @UseGuards(DeviceAuthGuard)
  @ApiOperation({summary: 'Employees who may sign in on this till'})
  async staff(@CurrentDevice() device: Device) {
    return {staff: await this.deviceService.staffFor(device)};
  }

  @Post('me/session')
  @HttpCode(HttpStatus.OK)
  @UseGuards(DeviceAuthGuard)
  @ApiOperation({summary: 'PIN sign-in on this till → staff session'})
  session(@CurrentDevice() device: Device, @Body() dto: DeviceSessionDto) {
    return this.deviceService.createSession(device, dto.staffId, dto.pin);
  }
}

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { PlanTierGuard } from '../subscription/plan-tier.guard';
import { MinTier } from '../subscription/required-tier.decorator';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { StaffService, redactStaff } from './staff.service';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';
import { PermissionService } from '../permission/permission.service';
import { CurrentAccount } from '../business/decorators/current-account.decorator';
import { IAccount } from '../business/types';

@ApiTags('staff')
@Controller('staff')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class StaffController {
  constructor(
    private readonly staffService: StaffService,
    private readonly permissions: PermissionService,
  ) {}

  /** How much of an employee record this caller may see. */
  private async access(account: IAccount) {
    const [full, payroll] = await Promise.all([
      this.permissions.can(account, 'staff:read'),
      this.permissions.can(account, 'staff:payroll:view'),
    ]);
    return {full, payroll};
  }

  @Get()
  @ApiOperation({
    summary: 'Get all staff for current business',
    description:
      'Shape depends on the caller: without `staff:read` only the roster ' +
      '(name, position, branch) — enough for the cashier filters that every ' +
      'sales and finance screen uses. With it, the full record; wages need ' +
      '`staff:payroll:view` on top.',
  })
  @ApiResponse({ status: 200, description: 'List of staff' })
  async findAll(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
  ) {
    const access = await this.access(account);
    const members = await this.staffService.findAll(business.id);
    return members.map((member) => redactStaff(member, access));
  }

  @Get('seat-usage')
  @RequirePermission('staff:read')
  @ApiOperation({
    summary: 'Plan seat usage — owner + staff who hold a system account',
  })
  @ApiResponse({ status: 200, description: '{ used, limit }' })
  async seatUsage(@CurrentBusiness() business: IBusiness) {
    return this.staffService.getSeatUsage(business.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get staff by id' })
  @ApiParam({ name: 'id', description: 'Staff ID' })
  @ApiResponse({ status: 200, description: 'Staff' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    const member = await this.staffService.findOne(business.id, id);
    if (!member) throw new AppException(ErrorCode.STAFF_NOT_FOUND);
    return redactStaff(member, await this.access(account));
  }

  @Post()
  @RequirePermission('staff:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a staff account' })
  @ApiResponse({ status: 201, description: 'Staff created' })
  @ApiResponse({ status: 409, description: 'Login already exists' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateStaffDto,
  ) {
    await this.assertMayAssignRole(business.id, account, dto.roleId);
    return this.staffService.create(business.id, dto);
  }

  @Put(':id')
  @RequirePermission('staff:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a staff account' })
  @ApiParam({ name: 'id', description: 'Staff ID' })
  @ApiResponse({ status: 200, description: 'Staff updated' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: UpdateStaffDto,
  ) {
    await this.assertMayAssignRole(business.id, account, dto.roleId);
    return this.staffService.update(business.id, id, dto);
  }

  @Delete(':id')
  @RequirePermission('staff:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a staff account' })
  @ApiParam({ name: 'id', description: 'Staff ID' })
  @ApiResponse({ status: 200, description: 'Staff deleted' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.staffService.remove(business.id, id);
    return { message: 'Staff deleted successfully' };
  }

  /**
   * A delegated manager may not hand out rights they do not hold themselves —
   * otherwise `staff:manage` would be a path to owner, by assigning someone
   * (or oneself) a role that carries everything. The owner is exempt.
   */
  private async assertMayAssignRole(
    businessId: string,
    account: IAccount,
    roleId?: string | null,
  ) {
    if (!roleId || account.type === 'business') return;
    const role = await this.staffService.findRolePermissions(businessId, roleId);
    await this.permissions.assertCanGrant(account, role);
  }
}

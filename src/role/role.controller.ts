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
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleService } from './role.service';
import { PERMISSION_CATALOG } from '../permission/permission.catalog';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';
import { PermissionService } from '../permission/permission.service';
import { CurrentAccount } from '../business/decorators/current-account.decorator';
import { IAccount } from '../business/types';

@ApiTags('roles')
@Controller('roles')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class RoleController {
  constructor(
    private readonly roleService: RoleService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @RequirePermission('staff:read')
  @ApiOperation({ summary: 'Get all roles for current business' })
  @ApiResponse({ status: 200, description: 'List of roles' })
  async findAll(@CurrentBusiness() business: IBusiness) {
    return this.roleService.findAll(business.id);
  }

  @Get('permissions')
  @ApiOperation({
    summary: 'The action-permission catalogue the roles UI renders',
  })
  @ApiResponse({ status: 200, description: 'List of {key, group}' })
  permissionCatalog() {
    // Served from the server so the checkboxes a shop sees can never drift from
    // the keys the guards actually enforce. Declared BEFORE @Get(':id') — Nest
    // matches in declaration order and ':id' would otherwise swallow it.
    return PERMISSION_CATALOG;
  }

  @Get(':id')
  @RequirePermission('staff:read')
  @ApiOperation({ summary: 'Get role by id' })
  @ApiParam({ name: 'id', description: 'Role ID' })
  @ApiResponse({ status: 200, description: 'Role' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const role = await this.roleService.findOne(business.id, id);
    if (!role) throw new AppException(ErrorCode.ROLE_NOT_FOUND);
    return role;
  }

  @Post()
  @RequirePermission('role:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a role' })
  @ApiResponse({ status: 201, description: 'Role created' })
  @ApiResponse({ status: 409, description: 'Role name already exists' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateRoleDto,
  ) {
    await this.permissions.assertCanGrant(account, dto.permissions ?? []);
    return this.roleService.create(business.id, dto);
  }

  @Put(':id')
  @RequirePermission('role:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a role' })
  @ApiParam({ name: 'id', description: 'Role ID' })
  @ApiResponse({ status: 200, description: 'Role updated' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    // Both directions matter: a delegated manager may not ADD a right they
    // lack, and may not edit a role that already carries one (which would let
    // them rename it into something they then assign to themselves).
    const existing = await this.roleService.findOne(business.id, id);
    if (!existing) throw new AppException(ErrorCode.ROLE_NOT_FOUND);
    await this.permissions.assertCanGrant(account, existing.permissions ?? []);
    await this.permissions.assertCanGrant(account, dto.permissions ?? []);
    return this.roleService.update(business.id, id, dto);
  }

  @Delete(':id')
  @RequirePermission('role:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a role' })
  @ApiParam({ name: 'id', description: 'Role ID' })
  @ApiResponse({ status: 200, description: 'Role deleted' })
  @ApiResponse({ status: 404, description: 'Not found' })
  @ApiResponse({ status: 409, description: 'Role still assigned to staff' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    // Deleting a role is not a way around the grant rule either: a manager who
    // could not create this role must not be able to destroy it.
    const existing = await this.roleService.findOne(business.id, id);
    if (!existing) throw new AppException(ErrorCode.ROLE_NOT_FOUND);
    await this.permissions.assertCanGrant(account, existing.permissions ?? []);
    await this.roleService.remove(business.id, id);
    return { message: 'Role deleted successfully' };
  }
}

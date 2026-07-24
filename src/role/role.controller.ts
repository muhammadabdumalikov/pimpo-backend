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
import { OwnerGuard } from '../business/owner.guard';
import { PlanTierGuard } from '../subscription/plan-tier.guard';
import { MinTier } from '../subscription/required-tier.decorator';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleService } from './role.service';

@ApiTags('roles')
@Controller('roles')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @ApiOperation({ summary: 'Get all roles for current business' })
  @ApiResponse({ status: 200, description: 'List of roles' })
  async findAll(@CurrentBusiness() business: IBusiness) {
    return this.roleService.findAll(business.id);
  }

  @Get(':id')
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
  @UseGuards(OwnerGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a role (owner only)' })
  @ApiResponse({ status: 201, description: 'Role created' })
  @ApiResponse({ status: 409, description: 'Role name already exists' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateRoleDto,
  ) {
    return this.roleService.create(business.id, dto);
  }

  @Put(':id')
  @UseGuards(OwnerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a role (owner only)' })
  @ApiParam({ name: 'id', description: 'Role ID' })
  @ApiResponse({ status: 200, description: 'Role updated' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.roleService.update(business.id, id, dto);
  }

  @Delete(':id')
  @UseGuards(OwnerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a role (owner only)' })
  @ApiParam({ name: 'id', description: 'Role ID' })
  @ApiResponse({ status: 200, description: 'Role deleted' })
  @ApiResponse({ status: 404, description: 'Not found' })
  @ApiResponse({ status: 409, description: 'Role still assigned to staff' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.roleService.remove(business.id, id);
    return { message: 'Role deleted successfully' };
  }
}

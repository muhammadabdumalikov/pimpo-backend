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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { BranchService } from './branch.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';

@ApiTags('branches')
@Controller('branches')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class BranchController {
  constructor(private readonly branchService: BranchService) {}

  @Get()
  @ApiOperation({ summary: 'List branches (do\'konlar)' })
  @ApiResponse({ status: 200, description: 'Branches returned' })
  async findAll(@CurrentBusiness() business: IBusiness) {
    const branches = await this.branchService.findAll(business.id);
    return { branches };
  }

  @Post()
  @RequirePermission('settings:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a branch' })
  @ApiResponse({ status: 201, description: 'Branch created' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateBranchDto,
  ) {
    return this.branchService.create(business.id, dto);
  }

  @Put(':id')
  @RequirePermission('settings:manage')
  @ApiOperation({ summary: 'Update a branch' })
  @ApiParam({ name: 'id', description: 'Branch id' })
  @ApiResponse({ status: 200, description: 'Branch updated' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branchService.update(business.id, id, dto);
  }

  @Delete(':id')
  @RequirePermission('settings:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deactivate a branch (default cannot be removed)' })
  @ApiParam({ name: 'id', description: 'Branch id' })
  @ApiResponse({ status: 204, description: 'Branch deactivated' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.branchService.remove(business.id, id);
  }
}

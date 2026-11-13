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
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { BranchService } from './branch.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { CurrentAccount } from '../business/decorators/current-account.decorator';
import { IAccount, IBusiness } from '../business/types';
import { BillingService } from '../billing/billing.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { CopyAssortmentDto } from './dto/copy-assortment.dto';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';

@ApiTags('branches')
@Controller('branches')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class BranchController {
  constructor(
    private readonly branchService: BranchService,
    private readonly billingService: BillingService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List branches (do\'konlar)' })
  @ApiResponse({ status: 200, description: 'Branches returned' })
  async findAll(@CurrentBusiness() business: IBusiness) {
    const branches = await this.branchService.findAll(business.id);
    return { branches };
  }

  // Before any ':id' route so the literal path is never read as an id.
  @Get('billing-preview')
  @RequirePermission('settings:manage')
  @ApiOperation({ summary: 'What opening one more branch charges now' })
  @ApiResponse({ status: 200, description: 'Branch billing preview' })
  async billingPreview(@CurrentBusiness() business: IBusiness) {
    return this.billingService.previewBranchCharge(business.id);
  }

  @Post()
  @RequirePermission('settings:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a branch' })
  @ApiResponse({ status: 201, description: 'Branch created' })
  @ApiResponse({ status: 409, description: 'BILLING_INSUFFICIENT_BALANCE' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateBranchDto,
  ) {
    return this.branchService.create(business.id, dto, account?.id ?? business.id);
  }

  @Get(':id/assortment-preview')
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary: 'Cards another branch stocks that this one lacks, per category',
  })
  @ApiParam({ name: 'id', description: 'Receiving branch id' })
  @ApiQuery({ name: 'fromBranchId', required: true })
  @ApiQuery({ name: 'liveOnly', required: false, type: Boolean })
  async assortmentPreview(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Query('fromBranchId') fromBranchId: string,
    @Query('liveOnly') liveOnly?: string,
  ) {
    return this.branchService.assortmentPreview(
      business.id,
      id,
      fromBranchId,
      liveOnly !== 'false',
    );
  }

  @Post(':id/copy-assortment')
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary: "Copy another branch's assortment here (0-stock rows; adds only missing)",
  })
  @ApiParam({ name: 'id', description: 'Receiving branch id' })
  async copyAssortment(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: CopyAssortmentDto,
  ) {
    return this.branchService.copyAssortment(business.id, id, dto);
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

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {CurrentAccount} from '../../business/decorators/current-account.decorator';
import {CurrentBusiness} from '../../business/decorators/current-business.decorator';
import {JwtAuthGuard} from '../../business/jwt-auth.guard';
import {IAccount, IBusiness} from '../../business/types';
import {RequirePermission} from '../../permission/permission.decorator';
import {PermissionService} from '../../permission/permission.service';
import {PermissionsGuard} from '../../permission/permissions.guard';
import {MinTier} from '../../subscription/required-tier.decorator';
import {PlanTierGuard} from '../../subscription/plan-tier.guard';
import {SaveScanDto} from './dto/invoice-scan.dto';
import {InvoiceScanService} from './invoice-scan.service';

/**
 * Delivery-note scans under review, saved as they go ("tugallanmagan skaner").
 *
 * Only the AI read and the owner's corrections are stored; the photos go
 * through POST /ai/invoice/parse and are never kept. The scan is the first
 * step of a goods receipt, so it takes the same right as writing one
 * (receipt:create) and the same plan as the AI read (pro). The scans are the
 * shop's: anyone with that right lists, continues and finishes any of them.
 */
@ApiTags('ai')
@Controller('ai/invoice/scans')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('pro')
@RequirePermission('receipt:create')
@ApiBearerAuth('JWT-auth')
export class InvoiceScanController {
  constructor(
    private readonly scans: InvoiceScanService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @ApiOperation({summary: "The shop's unfinished scans, newest activity first"})
  async list(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
  ) {
    return {scans: await this.scans.list(business.id, account.id)};
  }

  @Get(':id')
  @ApiOperation({summary: 'One scan with its review state, for resuming'})
  async get(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    return {scan: await this.scans.get(business.id, account.id, id)};
  }

  @Post()
  @ApiOperation({summary: 'Keep a scan once its first read is back'})
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: SaveScanDto,
  ) {
    return {scan: await this.scans.create(business.id, account.id, dto)};
  }

  @Patch(':id')
  @ApiOperation({summary: 'Autosave the review'})
  save(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: SaveScanDto,
  ) {
    return this.scans.save(business.id, account.id, id, dto);
  }

  @Get(':id/products')
  @ApiOperation({
    summary: 'Products made for this scan, and which can still be removed',
  })
  async createdProducts(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return {products: await this.scans.createdProducts(business.id, id)};
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Finish or discard a scan; deleteProducts=true also removes the ' +
      'untouched products it made',
  })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Query('deleteProducts') deleteProducts?: string,
  ) {
    const alsoProducts = deleteProducts === 'true';
    // Removing catalogue items is its own right, whatever made them.
    if (alsoProducts) await this.permissions.assert(account, 'product:delete');
    return this.scans.remove(business.id, id, alsoProducts);
  }
}

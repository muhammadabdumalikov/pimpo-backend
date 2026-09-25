import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiQuery, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {FeatureGuard} from '../feature/feature.guard';
import {RequireFeature} from '../feature/require-feature.decorator';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount, IBusiness} from '../business/types';
import {DEFECTIVE_MOVEMENT_TYPES} from '../common/defective-stock';
import {DefectiveService} from './defective.service';
import {
  DefectiveSupplierReturnDto,
  ExchangeDefectiveDto,
  MoveToDefectiveDto,
  OpeningDefectiveDto,
  ReleaseDefectiveDto,
  WriteOffDefectiveDto,
} from './dto/defective.dto';

// Yaroqsiz tovarlar ombori. The till's defective customer returns land here
// through the sale-return flow (sale:return); everything on this controller is
// the shop deciding what happens to the goods, behind defective:manage.
//
// Rolling out per shop behind the `defective_store` flag. FeatureGuard runs
// before the tier check so a shop without the flag hears "not enabled", not
// "upgrade your plan".
@ApiTags('defective-stock')
@Controller('defective-stock')
@UseGuards(JwtAuthGuard, FeatureGuard, PlanTierGuard, PermissionsGuard)
@RequireFeature('defective_store')
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class DefectiveController {
  constructor(private readonly defectiveService: DefectiveService) {}

  @Get()
  @RequirePermission('defective:manage')
  @ApiOperation({summary: 'Defective stock on hand, per product and branch'})
  @ApiQuery({name: 'branchId', required: false})
  @ApiQuery({name: 'productId', required: false})
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Name, code or barcode',
  })
  list(
    @CurrentBusiness() business: IBusiness,
    @Query('branchId') branchId?: string,
    @Query('productId') productId?: string,
    @Query('search') search?: string,
  ) {
    return this.defectiveService.list(business.id, {
      branchId,
      productId,
      search,
    });
  }

  @Get('movements')
  @RequirePermission('defective:manage')
  @ApiOperation({summary: 'Defective stock movement history, newest first'})
  @ApiQuery({name: 'branchId', required: false})
  @ApiQuery({name: 'productId', required: false})
  @ApiQuery({name: 'type', required: false, enum: DEFECTIVE_MOVEMENT_TYPES})
  @ApiQuery({name: 'from', required: false})
  @ApiQuery({name: 'to', required: false})
  @ApiQuery({name: 'page', required: false})
  @ApiQuery({name: 'limit', required: false})
  movements(
    @CurrentBusiness() business: IBusiness,
    @Query('branchId') branchId?: string,
    @Query('productId') productId?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.defectiveService.movements(business.id, {
      branchId,
      productId,
      type: (DEFECTIVE_MOVEMENT_TYPES as readonly string[]).includes(type ?? '')
        ? type
        : undefined,
      from,
      to,
      page: page ? Number(page) || 1 : 1,
      limit: limit ? Number(limit) || 20 : 20,
    });
  }

  @Get('opening-status')
  @RequirePermission('defective:manage')
  @ApiOperation({
    summary: 'Whether opening defective stock can still be entered',
  })
  openingStatus(@CurrentBusiness() business: IBusiness) {
    return this.defectiveService.openingStatus(business.id);
  }

  @Get('supplier-candidates')
  @RequirePermission('defective:manage')
  @ApiOperation({
    summary:
      'Receipts with debt that brought these products in — where a supplier return can go',
  })
  @ApiQuery({
    name: 'productIds',
    required: true,
    description: 'Comma-separated',
  })
  supplierCandidates(
    @CurrentBusiness() business: IBusiness,
    @Query('productIds') productIds?: string,
  ) {
    return this.defectiveService.supplierCandidates(
      business.id,
      (productIds ?? '').split(',').map((s) => s.trim()),
    );
  }

  @Post('from-shelf')
  @RequirePermission('defective:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Move sellable stock into defective stock'})
  fromShelf(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: MoveToDefectiveDto,
  ) {
    return this.defectiveService.moveFromShelf(business.id, dto, account);
  }

  @Post('opening')
  @RequirePermission('defective:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Enter opening defective stock (owner, first 30 days)',
  })
  opening(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: OpeningDefectiveDto,
  ) {
    return this.defectiveService.opening(business.id, dto, account);
  }

  @Post('write-off')
  @RequirePermission('defective:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Write defective stock off (books the loss)'})
  writeOff(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: WriteOffDefectiveDto,
  ) {
    return this.defectiveService.writeOff(business.id, dto, account);
  }

  @Post('to-sale')
  @RequirePermission('defective:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Put defective stock back on sale'})
  toSale(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: ReleaseDefectiveDto,
  ) {
    return this.defectiveService.toSale(business.id, dto, account);
  }

  @Post('exchange')
  @RequirePermission('defective:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Supplier swapped defective units for good ones'})
  exchange(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: ExchangeDefectiveDto,
  ) {
    return this.defectiveService.exchange(business.id, dto, account);
  }

  @Post('supplier-return')
  @RequirePermission('defective:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Return defective stock to the supplier, off a receipt's debt",
  })
  supplierReturn(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: DefectiveSupplierReturnDto,
  ) {
    return this.defectiveService.supplierReturn(business.id, dto, account);
  }
}

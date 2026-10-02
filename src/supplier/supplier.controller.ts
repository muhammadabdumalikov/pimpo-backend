import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
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
  ApiQuery,
} from '@nestjs/swagger';
import {SupplierService} from './supplier.service';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount, IBusiness} from '../business/types';
import {CreateSupplierDto} from './dto/create-supplier.dto';
import {UpdateSupplierDto} from './dto/update-supplier.dto';
import {TransferAdvanceDto} from './dto/transfer-advance.dto';
import {PaySupplierFromAccountDto} from './dto/pay-supplier-from-account.dto';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';
import {FeatureGuard} from '../feature/feature.guard';
import {RequireFeature} from '../feature/require-feature.decorator';
import {SupplierDefectiveService} from '../defective/supplier-defective.service';
import {ReceiptService} from '../receipt/receipt.service';

@ApiTags('suppliers')
@Controller('suppliers')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class SupplierController {
  constructor(
    private readonly supplierService: SupplierService,
    private readonly supplierDefectiveService: SupplierDefectiveService,
    private readonly receiptService: ReceiptService,
  ) {}

  @Post()
  @RequirePermission('supplier:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Create a new supplier'})
  @ApiResponse({status: 201, description: 'Supplier created successfully'})
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() createSupplierDto: CreateSupplierDto,
  ) {
    const supplier = await this.supplierService.create(
      business.id,
      createSupplierDto,
    );
    return {message: 'Supplier created successfully', supplier};
  }

  @Get()
  @ApiOperation({summary: 'Get all suppliers for current business'})
  @ApiQuery({name: 'page', required: false, type: Number})
  @ApiQuery({name: 'limit', required: false, type: Number})
  @ApiQuery({name: 'search', required: false, type: String})
  @ApiResponse({status: 200, description: 'List of suppliers'})
  async findAll(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.supplierService.findAll(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
    });
  }

  // Yaroqsiz tovarlar from the supplier side (YOQOTISHLAR.md S1–S13). Behind
  // the defective_store flag, like the store itself, but with no permission:
  // whoever can see suppliers sees their figures; acting on the goods goes
  // through /defective-stock, which asks for defective:manage.
  //
  // Declared before ':id' so the path is not taken for a supplier id.
  @Get('defective-summary')
  @UseGuards(FeatureGuard)
  @RequireFeature('defective_store')
  @ApiOperation({
    summary:
      'Defective stock per supplier: products, value at cost, returnable now',
  })
  @ApiResponse({status: 200, description: 'Suppliers with defective stock'})
  async defectiveSummary(@CurrentBusiness() business: IBusiness) {
    return this.supplierDefectiveService.summary(business.id);
  }

  // The supplier's credit with us (YOQOTISHLAR.md S22). Not behind the
  // defective_store flag: once a credit exists it must stay visible and
  // spendable even if the store is switched off. Declared before ':id'.
  @Get('credit-summary')
  @ApiOperation({summary: "Every supplier's non-zero credit, per currency"})
  async creditSummary(@CurrentBusiness() business: IBusiness) {
    return this.supplierService.creditSummary(business.id);
  }

  @Get(':id')
  @ApiOperation({summary: 'Get a supplier by ID'})
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiResponse({status: 200, description: 'Supplier details'})
  @ApiResponse({status: 404, description: 'Supplier not found'})
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const supplier = await this.supplierService.findOne(business.id, id);
    if (!supplier) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
    }
    return supplier;
  }

  @Get(':id/products')
  @ApiOperation({
    summary:
      'Products of one supplier: assigned to them and/or received from them',
  })
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiQuery({name: 'page', required: false, type: Number})
  @ApiQuery({name: 'limit', required: false, type: Number})
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Name, code or barcode',
  })
  @ApiQuery({
    name: 'stock',
    required: false,
    enum: ['in', 'low', 'out'],
    description: 'Stock status bucket',
  })
  @ApiQuery({name: 'categoryId', required: false, type: String})
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['all', 'assigned', 'received'],
    description:
      "'assigned' = the product's default supplier, 'received' = actually delivered by them (default: either)",
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['recent', 'name', 'quantity', 'spend'],
  })
  @ApiResponse({status: 200, description: "The supplier's products"})
  @ApiResponse({status: 404, description: 'Supplier not found'})
  async findProducts(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('stock') stock?: string,
    @Query('categoryId') categoryId?: string,
    @Query('source') source?: string,
    @Query('sort') sort?: string,
  ) {
    // The supplier is resolved first: an id from another business must 404
    // here, not quietly return an empty product list.
    const supplier = await this.supplierService.findOne(business.id, id);
    if (!supplier) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
    }
    return this.supplierService.findProducts(business.id, id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search: search || undefined,
      stock:
        stock === 'in' || stock === 'low' || stock === 'out'
          ? stock
          : undefined,
      categoryId: categoryId || undefined,
      source:
        source === 'assigned' || source === 'received' || source === 'all'
          ? source
          : undefined,
      sort:
        sort === 'name' ||
        sort === 'quantity' ||
        sort === 'spend' ||
        sort === 'recent'
          ? sort
          : undefined,
    });
  }

  @Get(':id/credit')
  @ApiOperation({
    summary: "One supplier's credit: balances per currency and its history",
  })
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiResponse({status: 404, description: 'Supplier not found'})
  async credit(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const supplier = await this.supplierService.findOne(business.id, id);
    if (!supplier) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
    }
    return this.supplierService.credit(business.id, id);
  }

  @Post(':id/advance-transfer')
  @RequirePermission('receipt:pay')
  @ApiOperation({
    summary:
      "Move a supplier's advance to another supplier (Avansni o'tkazish); with settle, it then pays their open receipts oldest first",
  })
  @ApiParam({name: 'id', description: 'Supplier the advance moves from'})
  async transferAdvance(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: TransferAdvanceDto,
  ) {
    return this.receiptService.transferAdvance(business.id, id, dto, account);
  }

  @Get(':id/open-debt')
  @RequirePermission('receipt:read')
  @ApiOperation({
    summary:
      "A supplier's open receipts (oldest first), their debt and advance in one currency",
  })
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiQuery({name: 'currency', required: false, enum: ['UZS', 'USD']})
  async openDebt(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Query('currency') currency?: string,
  ) {
    return this.receiptService.tillDebt(
      business.id,
      id,
      currency === 'USD' ? 'USD' : 'UZS',
    );
  }

  // "Ta'minotchiga to'lov" in Moliya. finance:manage, the permission of the
  // form it lives in: asking for receipt:pay too would send whoever lacks it
  // back to booking goods money as an expense — the fake loss this replaces.
  @Post(':id/finance-payments')
  @RequirePermission('finance:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Pay a supplier from a Moliya account or Tashqi mablag': settles their open receipts oldest first, the rest becomes their advance",
  })
  @ApiParam({name: 'id', description: 'Supplier ID'})
  async payFromAccount(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: PaySupplierFromAccountDto,
  ) {
    return this.receiptService.payFromAccount(business.id, id, dto, account);
  }

  // The same figures as open-debt, for the Moliya form (finance:manage).
  @Get(':id/finance-debt')
  @RequirePermission('finance:manage')
  @ApiOperation({
    summary:
      "A supplier's open receipts, debt and advance in one currency — for Moliya's payment form",
  })
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiQuery({name: 'currency', required: false, enum: ['UZS', 'USD']})
  async financeDebt(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Query('currency') currency?: string,
  ) {
    return this.receiptService.tillDebt(
      business.id,
      id,
      currency === 'USD' ? 'USD' : 'UZS',
    );
  }

  @Get(':id/defective')
  @UseGuards(FeatureGuard)
  @RequireFeature('defective_store')
  @ApiOperation({
    summary:
      "This supplier's products in defective stock, per branch, with what can go back now",
  })
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiQuery({name: 'branchId', required: false, type: String})
  @ApiResponse({status: 404, description: 'Supplier not found'})
  async defective(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Query('branchId') branchId?: string,
  ) {
    const supplier = await this.supplierService.findOne(business.id, id);
    if (!supplier) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
    }
    return this.supplierDefectiveService.forSupplier(business.id, id, {
      branchId: branchId || undefined,
    });
  }

  @Get(':id/defective/history')
  @UseGuards(FeatureGuard)
  @RequireFeature('defective_store')
  @ApiOperation({
    summary:
      'Defective goods that went back to this supplier: returns and exchanges',
  })
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiQuery({name: 'branchId', required: false, type: String})
  @ApiQuery({name: 'from', required: false, description: 'YYYY-MM-DD'})
  @ApiQuery({name: 'to', required: false, description: 'YYYY-MM-DD'})
  @ApiQuery({name: 'page', required: false, type: Number})
  @ApiQuery({name: 'limit', required: false, type: Number})
  @ApiResponse({status: 404, description: 'Supplier not found'})
  async defectiveHistory(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Query('branchId') branchId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const supplier = await this.supplierService.findOne(business.id, id);
    if (!supplier) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
    }
    return this.supplierDefectiveService.history(business.id, id, {
      branchId: branchId || undefined,
      from: from || undefined,
      to: to || undefined,
      page: page ? Number(page) || 1 : 1,
      limit: limit ? Number(limit) || 20 : 20,
    });
  }

  @Put(':id')
  @RequirePermission('supplier:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update a supplier'})
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiResponse({status: 200, description: 'Supplier updated successfully'})
  @ApiResponse({status: 404, description: 'Supplier not found'})
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() updateSupplierDto: UpdateSupplierDto,
  ) {
    const supplier = await this.supplierService.update(
      business.id,
      id,
      updateSupplierDto,
    );
    return {message: 'Supplier updated successfully', supplier};
  }

  @Delete(':id')
  @RequirePermission('supplier:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Delete a supplier'})
  @ApiParam({name: 'id', description: 'Supplier ID'})
  @ApiResponse({status: 200, description: 'Supplier deleted successfully'})
  @ApiResponse({status: 404, description: 'Supplier not found'})
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.supplierService.remove(business.id, id);
    return {message: 'Supplier deleted successfully'};
  }
}

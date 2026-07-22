import {Controller, Get, Query, UseGuards} from '@nestjs/common';
import {ApiTags, ApiOperation, ApiBearerAuth, ApiQuery} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {ReportService} from './report.service';

@ApiTags('reports')
@Controller('reports')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Get('pnl')
  @ApiOperation({summary: 'Foyda va zararlar (P&L) for a date range'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getPnl(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getPnl(business.id, {from, to, branchId});
  }

  @Get('stock')
  @ApiOperation({summary: 'Qoldiqlar bo\'yicha hisobot (stock valuation as of a date)'})
  @ApiQuery({name: 'date', required: false, description: 'ISO date; defaults to now'})
  async getStock(
    @CurrentBusiness() business: IBusiness,
    @Query('date') date?: string,
  ) {
    return this.reportService.getStock(business.id, date);
  }

  @Get('product-movement')
  @ApiOperation({summary: 'Tovarlar samaradorligi (kelim→sotuv→qoldiq)'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getProductMovement(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getProductMovement(business.id, {from, to, branchId});
  }

  @Get('sellers')
  @ApiOperation({summary: 'Sotuvchilar hisoboti (per-cashier KPIs)'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getSellers(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getSellers(business.id, {from, to, branchId});
  }

  @Get('customers')
  @ApiOperation({summary: 'Mijozlar hisoboti (new/returning, avg check, top)'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getCustomers(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getCustomers(business.id, {from, to, branchId});
  }

  @Get('imports')
  @ApiOperation({summary: 'Importlar (prixod) hisoboti'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getImports(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getImports(business.id, {from, to, branchId});
  }

  @Get('supplier-returns')
  @ApiOperation({summary: 'Ta\'minotchiga qaytarishlar hisoboti'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getSupplierReturns(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getSupplierReturns(business.id, {from, to, branchId});
  }

  @Get('stock-takes')
  @ApiOperation({summary: 'Inventarizatsiya natijalari hisoboti'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  async getStockTakes(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportService.getStockTakes(business.id, {from, to});
  }

  // ═══ Level-1 reports (HISOBOTLAR.md §6) ═══════════════════════════════════

  @Get('sales')
  @ApiOperation({summary: 'Sotuvlar dinamikasi (kun/hafta/oy bo\'yicha)'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  @ApiQuery({name: 'groupBy', required: false, enum: ['day', 'week', 'month']})
  async getSales(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('groupBy') groupBy?: string,
  ) {
    const g = groupBy === 'week' || groupBy === 'month' ? groupBy : 'day';
    return this.reportService.getSales(business.id, {from, to, branchId}, g);
  }

  @Get('traffic')
  @ApiOperation({summary: 'Soat × hafta kuni yuklama (heatmap)'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getTraffic(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getTraffic(business.id, {from, to, branchId});
  }

  @Get('shifts')
  @ApiOperation({summary: 'Kassa smenalari yig\'masi (Z-hisobot)'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  async getShifts(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportService.getShifts(business.id, {from, to});
  }

  @Get('payment-methods')
  @ApiOperation({summary: 'To\'lov usullari bo\'yicha'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getPaymentMethods(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getPaymentMethods(business.id, {from, to, branchId});
  }

  @Get('discounts')
  @ApiOperation({summary: 'Chegirmalar (kassir kesimida)'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getDiscounts(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getDiscounts(business.id, {from, to, branchId});
  }

  @Get('cancelled')
  @ApiOperation({summary: 'Bekor qilingan cheklar'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getCancelled(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getCancelled(business.id, {from, to, branchId});
  }

  // ═══ Level-2 reports (HISOBOTLAR.md §6, 2-daraja) ═════════════════════════

  @Get('debt-aging')
  @ApiOperation({summary: 'Nasiya (qarzlar) aging — as-of-now snapshot'})
  async getDebtAging(@CurrentBusiness() business: IBusiness) {
    return this.reportService.getDebtAging(business.id);
  }

  @Get('dead-stock')
  @ApiOperation({summary: "O'lik va sekin zaxira (N kun sotilmagan)"})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  @ApiQuery({name: 'days', required: false, description: 'Lookback window (default 30)'})
  async getDeadStock(
    @CurrentBusiness() business: IBusiness,
    @Query('branchId') branchId?: string,
    @Query('days') days?: string,
  ) {
    const d = Number(days);
    return this.reportService.getDeadStock(
      business.id,
      branchId,
      Number.isFinite(d) && d > 0 ? d : 30,
    );
  }

  @Get('reorder')
  @ApiOperation({summary: 'Qayta buyurtma / tugash prognozi'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  @ApiQuery({name: 'days', required: false, description: 'Velocity window (default 30)'})
  @ApiQuery({name: 'coverDays', required: false, description: 'Cover target days (default 14)'})
  async getReorder(
    @CurrentBusiness() business: IBusiness,
    @Query('branchId') branchId?: string,
    @Query('days') days?: string,
    @Query('coverDays') coverDays?: string,
  ) {
    const d = Number(days);
    const c = Number(coverDays);
    return this.reportService.getReorder(
      business.id,
      branchId,
      Number.isFinite(d) && d > 0 ? d : 30,
      Number.isFinite(c) && c > 0 ? c : 14,
    );
  }

  @Get('suppliers')
  @ApiOperation({summary: "Ta'minotchilar hisoboti (xarid, to'langan, qarz)"})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getSuppliers(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getSuppliers(business.id, {from, to, branchId});
  }

  @Get('assortment')
  @ApiOperation({summary: 'Kategoriya / brend kesimida sotuv va marja'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  @ApiQuery({name: 'dimension', required: false, enum: ['category', 'brand']})
  async getAssortment(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('dimension') dimension?: string,
  ) {
    const dim = dimension === 'brand' ? 'brand' : 'category';
    return this.reportService.getAssortment(business.id, {from, to, branchId}, dim);
  }

  @Get('branch-comparison')
  @ApiOperation({summary: 'Filiallar taqqoslash'})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  async getBranchComparison(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportService.getBranchComparison(business.id, {from, to});
  }

  @Get('transfers')
  @ApiOperation({summary: "Transferlar (filiallararo ko'chirishlar)"})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: 'Branch (source or destination)'})
  async getTransfers(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportService.getTransfers(business.id, {from, to, branchId});
  }
}

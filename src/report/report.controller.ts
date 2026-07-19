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
}

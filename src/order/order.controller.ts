import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
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
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IBusiness, IAccount} from '../business/types';
import {CreateOrderDto} from './dto/create-order.dto';
import {HoldOrderDto} from './dto/hold-order.dto';
import {UpdateOrderDto} from './dto/update-order.dto';
import {BatchCreateOrderDto} from './dto/batch-create-order.dto';
import {UpdateOrderStatusDto} from './dto/update-order-status.dto';
import {OrderService} from './order.service';

@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Create an order (decrements product stock)'})
  @ApiResponse({status: 201, description: 'Order created'})
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orderService.create(business.id, dto, account);
  }

  @Post('hold')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Park the cart as a held sale (stock is not decremented)',
  })
  @ApiResponse({status: 201, description: 'Held order created'})
  async hold(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: HoldOrderDto,
  ) {
    return this.orderService.hold(business.id, dto, account);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk-create queued offline orders (idempotent per clientId)',
  })
  @ApiResponse({status: 200, description: 'Per-order results'})
  async createBatch(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: BatchCreateOrderDto,
  ) {
    return this.orderService.createBatch(business.id, dto.orders, account);
  }

  @Get()
  @ApiOperation({summary: 'List orders for current business'})
  @ApiQuery({name: 'page', required: false})
  @ApiQuery({name: 'limit', required: false})
  @ApiQuery({name: 'search', required: false})
  @ApiQuery({name: 'status', required: false})
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'paymentMethod', required: false})
  @ApiQuery({name: 'cashierId', required: false})
  @ApiQuery({name: 'minAmount', required: false})
  @ApiQuery({name: 'maxAmount', required: false})
  async findAll(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('paymentMethod') paymentMethod?: string,
    @Query('cashierId') cashierId?: string,
    @Query('minAmount') minAmount?: string,
    @Query('maxAmount') maxAmount?: string,
  ) {
    const num = (v?: string) => {
      if (v == null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return this.orderService.findAll(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      status,
      from,
      to,
      paymentMethod,
      cashierId,
      minAmount: num(minAmount),
      maxAmount: num(maxAmount),
    });
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Sales summary (count/units/revenue + payment split) for a range',
  })
  @ApiQuery({name: 'from', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  async getSummary(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.orderService.getSalesSummary(business.id, {from, to});
  }

  @Get('count')
  @ApiOperation({summary: 'Get total order count'})
  async getCount(@CurrentBusiness() business: IBusiness) {
    return {count: await this.orderService.getCount(business.id)};
  }

  @Get('revenue')
  @ApiOperation({summary: 'Get total revenue from completed orders'})
  async getRevenue(@CurrentBusiness() business: IBusiness) {
    return {revenue: await this.orderService.getRevenue(business.id)};
  }

  @Get('monthly-sales')
  @ApiOperation({
    summary: 'Completed-order revenue per month for a year (12 values)',
  })
  @ApiQuery({
    name: 'year',
    required: false,
    description: 'Defaults to current year',
  })
  async getMonthlySales(
    @CurrentBusiness() business: IBusiness,
    @Query('year') year?: string,
  ) {
    const parsed = year ? parseInt(year, 10) : NaN;
    const y = Number.isFinite(parsed) ? parsed : new Date().getFullYear();
    return {
      year: y,
      monthly: await this.orderService.getMonthlySales(business.id, y),
    };
  }

  @Get('product-performance')
  @ApiOperation({
    summary: 'Per-product sales/revenue/profit from completed orders',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO date (inclusive)',
  })
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  @ApiQuery({name: 'branchId', required: false, description: "Branch (do'kon)"})
  async getProductPerformance(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.orderService.getProductPerformance(business.id, {from, to, branchId});
  }

  @Get('sales-by-employee')
  @ApiOperation({
    summary: 'Completed-order sales grouped by cashier (employee)',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO date (inclusive)',
  })
  @ApiQuery({name: 'to', required: false, description: 'ISO date (inclusive)'})
  async getSalesByEmployee(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.orderService.getSalesByEmployee(business.id, {from, to});
  }

  @Get('user/:userId')
  @ApiOperation({summary: 'Get orders for a specific customer'})
  @ApiParam({name: 'userId', description: 'Customer ID'})
  async findByUser(
    @CurrentBusiness() business: IBusiness,
    @Param('userId') userId: string,
  ) {
    return this.orderService.findByUser(business.id, userId);
  }

  @Get(':id')
  @ApiOperation({summary: 'Get order by id (with items)'})
  @ApiParam({name: 'id', description: 'Order ID'})
  @ApiResponse({status: 404, description: 'Not found'})
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const order = await this.orderService.findOne(business.id, id);
    if (!order) throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    return order;
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit sale metadata (date, customer, cashier, note)',
  })
  @ApiParam({name: 'id', description: 'Order ID'})
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.orderService.update(business.id, id, dto);
  }

  @Put(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update order status'})
  @ApiParam({name: 'id', description: 'Order ID'})
  async updateStatus(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orderService.updateStatus(business.id, id, dto.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Delete an order'})
  @ApiParam({name: 'id', description: 'Order ID'})
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.orderService.remove(business.id, id);
    return {message: 'Order deleted successfully'};
  }
}

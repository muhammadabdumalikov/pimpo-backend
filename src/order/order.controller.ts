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
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderService } from './order.service';

@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an order (decrements product stock)' })
  @ApiResponse({ status: 201, description: 'Order created' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orderService.create(business.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List orders for current business' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'status', required: false })
  async findAll(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.orderService.findAll(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      status,
    });
  }

  @Get('count')
  @ApiOperation({ summary: 'Get total order count' })
  async getCount(@CurrentBusiness() business: IBusiness) {
    return { count: await this.orderService.getCount(business.id) };
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Get total revenue from completed orders' })
  async getRevenue(@CurrentBusiness() business: IBusiness) {
    return { revenue: await this.orderService.getRevenue(business.id) };
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get orders for a specific customer' })
  @ApiParam({ name: 'userId', description: 'Customer ID' })
  async findByUser(
    @CurrentBusiness() business: IBusiness,
    @Param('userId') userId: string,
  ) {
    return this.orderService.findByUser(business.id, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order by id (with items)' })
  @ApiParam({ name: 'id', description: 'Order ID' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const order = await this.orderService.findOne(business.id, id);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  @Put(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update order status' })
  @ApiParam({ name: 'id', description: 'Order ID' })
  async updateStatus(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orderService.updateStatus(business.id, id, dto.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an order' })
  @ApiParam({ name: 'id', description: 'Order ID' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.orderService.remove(business.id, id);
    return { message: 'Order deleted successfully' };
  }
}

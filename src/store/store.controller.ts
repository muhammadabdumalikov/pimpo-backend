import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { StoreService } from './store.service';
import { CategoryService } from '../category/category.service';
import { OrderService } from '../order/order.service';
import { StoreCheckoutDto } from './dto/store-checkout.dto';

// The `store` query param carries the tenant's subdomain slug (e.g. "salom"
// from salom.kpos.uz). The ecommerce app reads it from the request Host and
// forwards it here on every call; resolveBusinessId turns it into the scoped
// business id (or the STORE_BUSINESS_ID env fallback on the apex / local dev).
@ApiTags('store')
@Controller('store')
export class StoreController {
  constructor(
    private readonly storeService: StoreService,
    private readonly categoryService: CategoryService,
    private readonly orderService: OrderService,
  ) {}

  @Get('info')
  @ApiOperation({ summary: 'Get storefront info for a slug (public)' })
  @ApiQuery({ name: 'store', required: false, type: String, description: 'Store subdomain slug' })
  @ApiResponse({ status: 200, description: 'Store name + slug' })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async getInfo(@Query('store') store?: string) {
    const businessId = await this.storeService.resolveBusinessId(store);
    return this.storeService.getInfo(businessId);
  }

  @Get('products')
  @ApiOperation({ summary: 'Get all store products (public)' })
  @ApiQuery({ name: 'store', required: false, type: String, description: 'Store subdomain slug' })
  @ApiQuery({ name: 'category', required: false, type: String, description: 'Filter by category ID' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search by product name' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiResponse({ status: 200, description: 'List of products' })
  async getProducts(
    @Query('store') store?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const businessId = await this.storeService.resolveBusinessId(store);
    return this.storeService.findAll(businessId, {
      category: category || undefined,
      search: search || undefined,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'Get a product by ID (public)' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiQuery({ name: 'store', required: false, type: String, description: 'Store subdomain slug' })
  @ApiResponse({ status: 200, description: 'Product details' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async getProduct(@Param('id') id: string, @Query('store') store?: string) {
    const businessId = await this.storeService.resolveBusinessId(store);
    return this.storeService.findOne(businessId, id);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Get store categories (public)' })
  @ApiQuery({ name: 'store', required: false, type: String, description: 'Store subdomain slug' })
  @ApiResponse({ status: 200, description: 'List of categories' })
  async getCategories(@Query('store') store?: string) {
    const businessId = await this.storeService.resolveBusinessId(store);
    return this.categoryService.findAllForStore(businessId ?? undefined);
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Get a store order status by id (public)' })
  @ApiParam({ name: 'id', description: 'Order ID (issued at checkout)' })
  @ApiQuery({ name: 'store', required: false, type: String, description: 'Store subdomain slug' })
  @ApiResponse({ status: 200, description: 'Order status + items' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrder(@Param('id') id: string, @Query('store') store?: string) {
    const businessId = await this.storeService.resolveBusinessId(store);
    return this.storeService.findOrder(businessId, id);
  }

  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Place a store order (public)' })
  @ApiQuery({ name: 'store', required: false, type: String, description: 'Store subdomain slug' })
  @ApiResponse({ status: 201, description: 'Order created' })
  async createOrder(
    @Body() dto: StoreCheckoutDto,
    @Query('store') store?: string,
  ) {
    const businessId = await this.storeService.resolveBusinessId(store);
    // Scope + stock guard: products must be in this store's catalog and on
    // hand, else the customer gets a clear error instead of an oversell.
    await this.storeService.assertOrderable(businessId, dto.items);

    const order = await this.orderService.createStore({
      items: dto.items,
      customerName: dto.customerName,
      phone: dto.phone,
      note: dto.note || undefined,
    });

    return {
      id: order.id,
      status: order.status,
      totalAmount: order.totalAmount,
      itemCount: order.itemCount,
      createdAt: order.createdAt,
    };
  }
}

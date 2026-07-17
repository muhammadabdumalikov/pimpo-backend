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
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ProductService } from './product.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { BulkCreateProductDto } from './dto/bulk-create-product.dto';

@ApiTags('products')
@Controller('products')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({
    status: 201,
    description: 'Product created successfully',
  })
  @ApiResponse({ status: 409, description: 'Product code already exists' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() createProductDto: CreateProductDto,
  ) {
    const product = await this.productService.create(business.id, createProductDto);
    return {
      message: 'Product created successfully',
      product,
    };
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-import products from a spreadsheet (Excel/CSV)' })
  @ApiResponse({
    status: 200,
    description: 'Import result: created count + skipped/errored rows',
  })
  @ApiResponse({ status: 403, description: 'Bulk import not available on this plan' })
  async bulkCreate(
    @CurrentBusiness() business: IBusiness,
    @Body() bulkCreateProductDto: BulkCreateProductDto,
  ) {
    const result = await this.productService.bulkCreate(
      business.id,
      bulkCreateProductDto.products,
    );
    return {
      message: `Imported ${result.created} product(s)`,
      ...result,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Get all products for current business' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search term' })
  @ApiResponse({
    status: 200,
    description: 'List of products',
  })
  async findAll(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.productService.findAll(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
    });
    return result;
  }

  @Get('count')
  @ApiOperation({ summary: 'Get total product count for current business' })
  @ApiResponse({
    status: 200,
    description: 'Product count',
  })
  async getCount(@CurrentBusiness() business: IBusiness) {
    const count = await this.productService.getCount(business.id);
    return { count };
  }

  @Get('generate-code')
  @ApiOperation({ summary: 'Generate a unique product code for current business' })
  @ApiResponse({
    status: 200,
    description: 'Generated product code',
  })
  async generateCode(@CurrentBusiness() business: IBusiness) {
    const code = await this.productService.generateProductCode(business.id);
    return { code };
  }

  @Get('generate-barcode')
  @ApiOperation({
    summary: 'Generate a fresh, unique EAN-13 barcode for current business',
  })
  @ApiResponse({ status: 200, description: 'Generated barcode' })
  async generateBarcode(@CurrentBusiness() business: IBusiness) {
    const barcode = await this.productService.generateBarcode(business.id);
    return { barcode };
  }

  @Get('lookup')
  @ApiOperation({
    summary: 'Look up a scanned barcode against own + shared community catalog',
  })
  @ApiQuery({ name: 'barcode', required: true, type: String, description: 'Barcode to look up' })
  @ApiResponse({ status: 200, description: 'Barcode lookup result' })
  async lookup(
    @CurrentBusiness() business: IBusiness,
    @Query('barcode') barcode?: string,
  ) {
    const trimmed = barcode?.trim();
    if (!trimmed) {
      throw new BadRequestException('barcode query parameter is required');
    }
    return this.productService.lookupBarcode(business.id, trimmed);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a product by ID' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({
    status: 200,
    description: 'Product details',
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const product = await this.productService.findOne(business.id, id);
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a product' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({
    status: 200,
    description: 'Product updated successfully',
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  @ApiResponse({ status: 409, description: 'Product code already exists' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    const product = await this.productService.update(business.id, id, updateProductDto);
    return {
      message: 'Product updated successfully',
      product,
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a product' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({
    status: 200,
    description: 'Product deleted successfully',
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.productService.remove(business.id, id);
    return {
      message: 'Product deleted successfully',
    };
  }
}

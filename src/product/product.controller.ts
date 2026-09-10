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
import {ProductService} from './product.service';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {CreateProductDto} from './dto/create-product.dto';
import {UpdateProductDto} from './dto/update-product.dto';
import {BulkCreateProductDto} from './dto/bulk-create-product.dto';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';

@ApiTags('products')
@Controller('products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  @RequirePermission('product:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Create a new product'})
  @ApiResponse({
    status: 201,
    description: 'Product created successfully',
  })
  @ApiResponse({status: 409, description: 'Product code already exists'})
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() createProductDto: CreateProductDto,
  ) {
    const product = await this.productService.create(
      business.id,
      createProductDto,
    );
    return {
      message: 'Product created successfully',
      product,
    };
  }

  @Post('bulk')
  @RequirePermission('product:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk-import products from a spreadsheet (Excel/CSV)',
  })
  @ApiResponse({
    status: 200,
    description: 'Import result: created count + skipped/errored rows',
  })
  @ApiResponse({
    status: 403,
    description: 'Bulk import not available on this plan',
  })
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
  @ApiOperation({summary: 'Get all products for current business'})
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term',
  })
  @ApiQuery({
    name: 'branchId',
    required: false,
    type: String,
    description: "Scope stock to a branch (do'kon)",
  })
  @ApiQuery({
    name: 'stock',
    required: false,
    enum: ['in', 'low', 'out'],
    description: 'Filter by stock status bucket',
  })
  @ApiQuery({
    name: 'supplierId',
    required: false,
    type: String,
    description:
      "Filter by the product's default supplier; 'none' = products with no supplier",
  })
  @ApiQuery({
    name: 'unitId',
    required: false,
    type: String,
    description:
      "Filter by unit of measure (o'lchov birligi); 'none' = products with no unit",
  })
  @ApiResponse({
    status: 200,
    description: 'List of products',
  })
  async findAll(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,
    @Query('stock') stock?: string,
    @Query('categoryId') categoryId?: string,
    @Query('supplierId') supplierId?: string,
    @Query('unitId') unitId?: string,
  ) {
    const stockFilter =
      stock === 'in' || stock === 'low' || stock === 'out' ? stock : undefined;
    const result = await this.productService.findAll(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      branchId: branchId || undefined,
      stock: stockFilter,
      categoryId: categoryId || undefined,
      supplierId: supplierId || undefined,
      unitId: unitId || undefined,
    });
    return result;
  }

  @Get('stats')
  @ApiOperation({
    summary:
      'Catalogue stats: stock-status counts, units on hand and supply/retail value',
  })
  @ApiQuery({name: 'search', required: false, type: String})
  @ApiQuery({name: 'branchId', required: false, type: String})
  @ApiQuery({name: 'categoryId', required: false, type: String})
  @ApiQuery({name: 'supplierId', required: false, type: String})
  @ApiQuery({name: 'unitId', required: false, type: String})
  async getStats(
    @CurrentBusiness() business: IBusiness,
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,
    @Query('categoryId') categoryId?: string,
    @Query('supplierId') supplierId?: string,
    @Query('unitId') unitId?: string,
  ) {
    return this.productService.getStats(business.id, {
      search,
      branchId: branchId || undefined,
      categoryId: categoryId || undefined,
      supplierId: supplierId || undefined,
      unitId: unitId || undefined,
    });
  }

  @Get('count')
  @ApiOperation({summary: 'Get total product count for current business'})
  @ApiResponse({
    status: 200,
    description: 'Product count',
  })
  async getCount(@CurrentBusiness() business: IBusiness) {
    const count = await this.productService.getCount(business.id);
    return {count};
  }

  @Get('generate-code')
  @ApiOperation({
    summary: 'Generate a unique product code for current business',
  })
  @ApiResponse({
    status: 200,
    description: 'Generated product code',
  })
  async generateCode(@CurrentBusiness() business: IBusiness) {
    const code = await this.productService.generateProductCode(business.id);
    return {code};
  }

  @Get('generate-barcode')
  @ApiOperation({
    summary: 'Generate a fresh, unique EAN-13 barcode for current business',
  })
  @ApiResponse({status: 200, description: 'Generated barcode'})
  async generateBarcode(@CurrentBusiness() business: IBusiness) {
    const barcode = await this.productService.generateBarcode(business.id);
    return {barcode};
  }

  @Get('generate-plu')
  @ApiOperation({
    summary: 'Lowest free scale PLU for the current business',
  })
  @ApiResponse({status: 200, description: 'Generated PLU'})
  async generatePlu(@CurrentBusiness() business: IBusiness) {
    const plu = await this.productService.generatePlu(business.id);
    return {plu};
  }

  @Get('lookup')
  @ApiOperation({
    summary: 'Look up a scanned barcode against own + shared community catalog',
  })
  @ApiQuery({
    name: 'barcode',
    required: true,
    type: String,
    description: 'Barcode to look up',
  })
  @ApiResponse({status: 200, description: 'Barcode lookup result'})
  async lookup(
    @CurrentBusiness() business: IBusiness,
    @Query('barcode') barcode?: string,
  ) {
    const trimmed = barcode?.trim();
    if (!trimmed) {
      throw new AppException(ErrorCode.BARCODE_QUERY_REQUIRED);
    }
    return this.productService.lookupBarcode(business.id, trimmed);
  }

  @Get('scan')
  @ApiOperation({
    summary:
      "Resolve a scanned code (plain barcode or 'Asl belgi' marking DataMatrix) to a product",
  })
  @ApiQuery({
    name: 'code',
    required: true,
    type: String,
    description: 'Raw scanner output, exactly as it arrived',
  })
  @ApiQuery({
    name: 'branchId',
    required: false,
    type: String,
    description: 'Scope stock to this branch (defaults to the cross-branch sum)',
  })
  @ApiResponse({
    status: 200,
    description: 'Resolved product (null when nothing matches) plus parsed code parts',
  })
  async scan(
    @CurrentBusiness() business: IBusiness,
    @Query('code') code?: string,
    @Query('branchId') branchId?: string,
  ) {
    const trimmed = code?.trim();
    if (!trimmed) {
      throw new AppException(ErrorCode.SCAN_CODE_REQUIRED);
    }
    return this.productService.resolveScannedCode(
      business.id,
      trimmed,
      branchId,
    );
  }

  // Declared before @Get(':id') so the literal path always wins the match.
  @Get('mxik/search')
  @ApiOperation({
    summary: "Search the national product classifier (IKPU / MXIK) by name, barcode or code",
  })
  @ApiQuery({
    name: 'q',
    required: true,
    type: String,
    description: 'Free-text name, full barcode, or MXIK code prefix (min 3 chars)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max rows to return (default 20, max 50)',
  })
  @ApiResponse({status: 200, description: 'Matching classifier rows'})
  async searchMxik(@Query('q') q?: string, @Query('limit') limit?: string) {
    const trimmed = q?.trim();
    if (!trimmed) {
      throw new AppException(ErrorCode.MXIK_QUERY_REQUIRED);
    }
    const parsed = Number(limit);
    const results = await this.productService.searchMxik(
      trimmed,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 20,
    );
    return {results};
  }

  @Get(':id')
  @ApiOperation({summary: 'Get a product by ID'})
  @ApiParam({name: 'id', description: 'Product ID'})
  @ApiResponse({
    status: 200,
    description: 'Product details',
  })
  @ApiResponse({status: 404, description: 'Product not found'})
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const product = await this.productService.findOne(business.id, id);
    if (!product) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
    }
    return product;
  }

  @Put(':id')
  @RequirePermission('product:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update a product'})
  @ApiParam({name: 'id', description: 'Product ID'})
  @ApiResponse({
    status: 200,
    description: 'Product updated successfully',
  })
  @ApiResponse({status: 404, description: 'Product not found'})
  @ApiResponse({status: 409, description: 'Product code already exists'})
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    const product = await this.productService.update(
      business.id,
      id,
      updateProductDto,
    );
    return {
      message: 'Product updated successfully',
      product,
    };
  }

  @Delete(':id')
  @RequirePermission('product:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Delete a product'})
  @ApiParam({name: 'id', description: 'Product ID'})
  @ApiResponse({
    status: 200,
    description: 'Product deleted successfully',
  })
  @ApiResponse({status: 404, description: 'Product not found'})
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

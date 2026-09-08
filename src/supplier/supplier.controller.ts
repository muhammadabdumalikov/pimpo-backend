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
import {IBusiness} from '../business/types';
import {CreateSupplierDto} from './dto/create-supplier.dto';
import {UpdateSupplierDto} from './dto/update-supplier.dto';

@ApiTags('suppliers')
@Controller('suppliers')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class SupplierController {
  constructor(private readonly supplierService: SupplierService) {}

  @Post()
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

  @Put(':id')
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

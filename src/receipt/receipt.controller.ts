import {
  Controller,
  Get,
  Post,
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
import { ReceiptService } from './receipt.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateReceiptDto } from './dto/create-receipt.dto';

@ApiTags('receipts')
@Controller('receipts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ReceiptController {
  constructor(private readonly receiptService: ReceiptService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a goods receipt (adds stock)' })
  @ApiResponse({ status: 201, description: 'Receipt created successfully' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() createReceiptDto: CreateReceiptDto,
  ) {
    const receipt = await this.receiptService.create(
      business.id,
      createReceiptDto,
    );
    return { message: 'Receipt created successfully', receipt };
  }

  @Get()
  @ApiOperation({ summary: 'Get all goods receipts for current business' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'supplierId', required: false, type: String })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiResponse({ status: 200, description: 'List of receipts' })
  async findAll(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('supplierId') supplierId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.receiptService.findAll(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      supplierId,
      startDate,
      endDate,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a goods receipt by ID (with items)' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  @ApiResponse({ status: 200, description: 'Receipt details' })
  @ApiResponse({ status: 404, description: 'Receipt not found' })
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const receipt = await this.receiptService.findOne(business.id, id);
    if (!receipt) {
      throw new NotFoundException('Receipt not found');
    }
    return receipt;
  }
}

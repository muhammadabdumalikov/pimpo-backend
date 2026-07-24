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
import { ReceiptService } from './receipt.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { PlanTierGuard } from '../subscription/plan-tier.guard';
import { MinTier } from '../subscription/required-tier.decorator';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { CurrentAccount } from '../business/decorators/current-account.decorator';
import { IBusiness, IAccount } from '../business/types';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { AddPaymentDto } from './dto/add-payment.dto';
import { CreateReturnDto } from './dto/create-return.dto';

@ApiTags('receipts')
@Controller('receipts')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('basic')
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
  @ApiQuery({ name: 'branchId', required: false, type: String })
  @ApiQuery({ name: 'paymentStatus', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiResponse({ status: 200, description: 'List of receipts' })
  async findAll(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('supplierId') supplierId?: string,
    @Query('branchId') branchId?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('status') status?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.receiptService.findAll(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      supplierId,
      branchId,
      paymentStatus,
      status,
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
      throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    }
    return receipt;
  }

  @Get(':id/payments')
  @ApiOperation({ summary: 'Payment history for a receipt' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  async getPayments(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.receiptService.getPayments(business.id, id);
  }

  @Post(':id/payments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a payment to the supplier (books a finance expense)' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  async addPayment(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: AddPaymentDto,
  ) {
    const result = await this.receiptService.addPayment(
      business.id,
      id,
      dto,
      account,
    );
    return { message: 'Payment recorded', ...result };
  }

  @Post(':id/receive')
  @ApiOperation({ summary: 'Receive a draft receipt (applies stock)' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  async receive(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const receipt = await this.receiptService.receiveReceipt(business.id, id);
    return { message: 'Receipt received', receipt };
  }

  @Get(':id/returns')
  @ApiOperation({ summary: 'Return history for a receipt' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  async getReturns(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.receiptService.getReturns(business.id, id);
  }

  @Post(':id/returns')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Return goods to the supplier (reverses stock + debt)' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  async createReturn(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: CreateReturnDto,
  ) {
    const result = await this.receiptService.createReturn(
      business.id,
      id,
      dto,
      account,
    );
    return { message: 'Return recorded', ...result };
  }
}

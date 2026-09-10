import {
  Controller,
  Get,
  Post,
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
import { ReceiptService } from './receipt.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { PlanTierGuard } from '../subscription/plan-tier.guard';
import { MinTier } from '../subscription/required-tier.decorator';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';
import { PermissionService } from '../permission/permission.service';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { CurrentAccount } from '../business/decorators/current-account.decorator';
import { IBusiness, IAccount } from '../business/types';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { UpdateReceiptDto } from './dto/update-receipt.dto';
import {UpdateReceiptHeaderDto} from './dto/update-receipt-header.dto';
import { AddPaymentDto } from './dto/add-payment.dto';
import { CreateReturnDto } from './dto/create-return.dto';

@ApiTags('receipts')
@Controller('receipts')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class ReceiptController {
  constructor(
    private readonly receiptService: ReceiptService,
    private readonly permissions: PermissionService,
  ) {}

  @Post()
  @RequirePermission('receipt:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a goods receipt (adds stock)' })
  @ApiResponse({ status: 201, description: 'Receipt created successfully' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() createReceiptDto: CreateReceiptDto,
  ) {
    // Saving a draft changes no stock and stays open to anyone who can reach
    // the page. Creating an already-received receipt applies stock in the same
    // call, so it is the same act as POST /:id/receive and needs the same
    // right — otherwise the permission would be bypassable by never drafting.
    if (!createReceiptDto.draft) {
      await this.permissions.assert(account, 'receipt:receive');
    }
    const receipt = await this.receiptService.create(
      business.id,
      createReceiptDto,
    );
    return { message: 'Receipt created successfully', receipt };
  }

  @Get()
  @RequirePermission('receipt:read')
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
  @RequirePermission('receipt:read')
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

  @Patch(':id')
  @RequirePermission('receipt:create')
  @ApiOperation({
    summary: 'Edit a DRAFT receipt (replaces its header and lines)',
    description:
      'Only a draft can be edited — it holds no stock. A received receipt is ' +
      'final and is refused here: correct it with a supplier return, or ' +
      'delete it (which takes its own explicit consent).',
  })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  @ApiResponse({ status: 200, description: 'Receipt updated' })
  @ApiResponse({
    status: 400,
    description: 'Receipt is not a draft',
  })
  @ApiResponse({ status: 404, description: 'Receipt not found' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() updateReceiptDto: UpdateReceiptDto,
  ) {
    const receipt = await this.receiptService.update(
      business.id,
      id,
      updateReceiptDto,
    );
    return { message: 'Receipt updated successfully', receipt };
  }

  @Patch(':id/header')
  @RequirePermission('receipt:create')
  @ApiOperation({
    summary:
      "Change a receipt's supplier and/or branch — allowed at any status. " +
      'Moving a received receipt to another branch moves its remaining stock.',
  })
  @ApiParam({name: 'id', description: 'Receipt ID'})
  @ApiResponse({status: 200, description: 'Receipt header updated'})
  @ApiResponse({
    status: 404,
    description: 'Receipt, supplier or branch not found',
  })
  async updateHeader(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateReceiptHeaderDto,
  ) {
    const receipt = await this.receiptService.updateHeader(
      business.id,
      id,
      dto,
    );
    return {message: 'Receipt header updated successfully', receipt};
  }

  @Delete(':id')
  @RequirePermission('receipt:delete')
  @ApiOperation({
    summary: 'Delete a receipt (owner only)',
    description:
      'A draft is removed outright. A received receipt is taken off stock ' +
      'first — batches dropped, cost recomputed from what remains — which ' +
      'needs ?amendReceived=true and is allowed only while none of it has ' +
      'been sold and it carries no payments or returns.',
  })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  @ApiResponse({ status: 200, description: 'Receipt deleted' })
  @ApiResponse({
    status: 400,
    description:
      'Already partly sold, has payments/returns, or received without ' +
      '?amendReceived=true',
  })
  @ApiResponse({ status: 403, description: 'Owner only' })
  @ApiResponse({ status: 404, description: 'Receipt not found' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    // A query string carries no booleans — it arrives as text.
    @Query('amendReceived') amendReceived?: string,
  ) {
    await this.receiptService.remove(business.id, id, {
      amendReceived: amendReceived === 'true',
    });
    return { message: 'Receipt deleted successfully' };
  }

  @Get(':id/payments')
  @RequirePermission('receipt:read')
  @ApiOperation({ summary: 'Payment history for a receipt' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  async getPayments(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.receiptService.getPayments(business.id, id);
  }

  @Post(':id/payments')
  @RequirePermission('receipt:pay')
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
  @RequirePermission('receipt:receive')
  @ApiOperation({ summary: 'Receive a draft receipt (applies stock)' })
  @ApiResponse({
    status: 403,
    description: 'Role lacks the receipt:receive permission',
  })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  async receive(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const receipt = await this.receiptService.receiveReceipt(business.id, id);
    return { message: 'Receipt received', receipt };
  }

  @Get(':id/returns')
  @RequirePermission('receipt:read')
  @ApiOperation({ summary: 'Return history for a receipt' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  async getReturns(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.receiptService.getReturns(business.id, id);
  }

  @Post(':id/returns')
  @RequirePermission('receipt:return')
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

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
import { DebtService } from './debt.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateDebtDto } from './dto/create-debt.dto';
import { UpdateDebtDto } from './dto/update-debt.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';

@ApiTags('debts')
@Controller('debts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class DebtController {
    constructor(private readonly debtService: DebtService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Create a new debt' })
    @ApiResponse({
        status: 201,
        description: 'Debt created successfully',
    })
    @ApiResponse({ status: 403, description: 'Debt limit reached' })
    async create(
        @CurrentBusiness() business: IBusiness,
        @Body() createDebtDto: CreateDebtDto,
    ) {
        const debt = await this.debtService.create(business.id, createDebtDto);
        return {
            message: 'Debt created successfully',
            debt,
        };
    }

    @Get()
    @ApiOperation({ summary: 'Get all debts for current business' })
    @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
    @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
    @ApiQuery({ name: 'search', required: false, type: String, description: 'Search term' })
    @ApiQuery({ name: 'status', required: false, type: String, description: 'Filter by status (Paid, Pending, Overdue)' })
    @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Created from (ISO date, inclusive)' })
    @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Created to (ISO date, inclusive)' })
    @ApiResponse({
        status: 200,
        description: 'List of debts',
    })
    async findAll(
        @CurrentBusiness() business: IBusiness,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
        @Query('search') search?: string,
        @Query('status') status?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
    ) {
        const result = await this.debtService.findAll(business.id, {
            page: page ? parseInt(page, 10) : undefined,
            limit: limit ? parseInt(limit, 10) : undefined,
            search,
            status,
            dateFrom,
            dateTo,
        });
        return result;
    }

    @Get('count')
    @ApiOperation({ summary: 'Get total debt count for current business' })
    @ApiResponse({
        status: 200,
        description: 'Debt count',
    })
    async getCount(@CurrentBusiness() business: IBusiness) {
        const count = await this.debtService.getCount(business.id);
        return { count };
    }

    @Get('grouped')
    @ApiOperation({ summary: 'Debts grouped by customer (sorted + paginated server-side)' })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'search', required: false, type: String })
    @ApiQuery({ name: 'status', required: false, type: String })
    @ApiQuery({ name: 'dateFrom', required: false, type: String })
    @ApiQuery({ name: 'dateTo', required: false, type: String })
    @ApiQuery({ name: 'sortBy', required: false, enum: ['date', 'amount', 'count'] })
    @ApiQuery({ name: 'sortDir', required: false, enum: ['asc', 'desc'] })
    async findGrouped(
        @CurrentBusiness() business: IBusiness,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
        @Query('search') search?: string,
        @Query('status') status?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
        @Query('sortBy') sortBy?: 'date' | 'amount' | 'count',
        @Query('sortDir') sortDir?: 'asc' | 'desc',
    ) {
        return this.debtService.findGrouped(business.id, {
            page: page ? parseInt(page, 10) : undefined,
            limit: limit ? parseInt(limit, 10) : undefined,
            search,
            status,
            dateFrom,
            dateTo,
            sortBy,
            sortDir,
        });
    }

    @Get('user/:userId')
    @ApiOperation({ summary: 'Get all debts for a specific user' })
    @ApiParam({ name: 'userId', description: 'User ID' })
    @ApiResponse({
        status: 200,
        description: 'List of debts for the user',
    })
    async findByUser(
        @CurrentBusiness() business: IBusiness,
        @Param('userId') userId: string,
    ) {
        const debts = await this.debtService.findByUser(business.id, userId);
        return { debts };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a debt by ID' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiResponse({
        status: 200,
        description: 'Debt details',
    })
    @ApiResponse({ status: 404, description: 'Debt not found' })
    async findOne(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
    ) {
        const debt = await this.debtService.findOne(business.id, id);
        if (!debt) {
            throw new AppException(ErrorCode.DEBT_NOT_FOUND);
        }
        return debt;
    }

    @Put(':id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Update a debt' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiResponse({
        status: 200,
        description: 'Debt updated successfully',
    })
    @ApiResponse({ status: 404, description: 'Debt not found' })
    async update(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
        @Body() updateDebtDto: UpdateDebtDto,
    ) {
        const debt = await this.debtService.update(business.id, id, updateDebtDto);
        return {
            message: 'Debt updated successfully',
            debt,
        };
    }

    @Delete(':id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete a debt' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiResponse({
        status: 200,
        description: 'Debt deleted successfully',
    })
    @ApiResponse({ status: 404, description: 'Debt not found' })
    async remove(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
    ) {
        await this.debtService.remove(business.id, id);
        return {
            message: 'Debt deleted successfully',
        };
    }

    // ─── Installment payments (Pro tier) ─────────────────────────────────────

    @Post(':id/payments')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Record an installment payment against a debt (Pro)' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiResponse({ status: 201, description: 'Payment recorded' })
    @ApiResponse({ status: 400, description: 'Payment exceeds remaining balance' })
    @ApiResponse({ status: 403, description: 'Pro plan required' })
    @ApiResponse({ status: 404, description: 'Debt not found' })
    async addPayment(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
        @Body() createPaymentDto: CreatePaymentDto,
    ) {
        const result = await this.debtService.addPayment(business.id, id, createPaymentDto);
        return {
            message: 'Payment recorded successfully',
            ...result,
        };
    }

    @Get(':id/payments')
    @ApiOperation({ summary: 'List installment payments for a debt (Pro)' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiResponse({ status: 200, description: 'Payment history' })
    @ApiResponse({ status: 403, description: 'Pro plan required' })
    async listPayments(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
    ) {
        const payments = await this.debtService.listPayments(business.id, id);
        return { payments };
    }

    @Delete(':id/payments/:paymentId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete an installment payment (Pro)' })
    @ApiParam({ name: 'id', description: 'Debt ID' })
    @ApiParam({ name: 'paymentId', description: 'Payment ID' })
    @ApiResponse({ status: 200, description: 'Payment deleted' })
    @ApiResponse({ status: 403, description: 'Pro plan required' })
    @ApiResponse({ status: 404, description: 'Payment not found' })
    async deletePayment(
        @CurrentBusiness() business: IBusiness,
        @Param('id') id: string,
        @Param('paymentId') paymentId: string,
    ) {
        await this.debtService.deletePayment(business.id, id, paymentId);
        return {
            message: 'Payment deleted successfully',
        };
    }
}

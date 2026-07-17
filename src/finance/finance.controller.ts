import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import {FinanceService} from './finance.service';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IBusiness, IAccount} from '../business/types';
import {CreateAccountDto} from './dto/create-account.dto';
import {UpdateAccountDto} from './dto/update-account.dto';
import {CreateFinanceCategoryDto} from './dto/create-finance-category.dto';
import {UpdateFinanceCategoryDto} from './dto/update-finance-category.dto';
import {CreateTransactionDto} from './dto/create-transaction.dto';
import {CreateTransferDto} from './dto/create-transfer.dto';
import {QueryTransactionsDto} from './dto/query-transactions.dto';

@ApiTags('finance')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  // ─── Accounts (Hisoblar) ──────────────────────────────────────────────────
  @Get('accounts')
  @ApiOperation({summary: 'List accounts with balances (Hisoblar holati)'})
  async getAccounts(@CurrentBusiness() business: IBusiness) {
    return this.financeService.getAccounts(business.id);
  }

  @Post('accounts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Create a financial account'})
  async createAccount(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateAccountDto,
  ) {
    const account = await this.financeService.createAccount(business.id, dto);
    return {message: 'Account created', account};
  }

  @Patch('accounts/:id')
  @ApiOperation({summary: 'Update an account (name / active)'})
  @ApiParam({name: 'id', description: 'Account ID'})
  async updateAccount(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
  ) {
    const account = await this.financeService.updateAccount(business.id, id, dto);
    return {message: 'Account updated', account};
  }

  // ─── Categories (Toifalar) ────────────────────────────────────────────────
  @Get('finance/categories')
  @ApiOperation({summary: 'List finance categories'})
  @ApiQuery({name: 'kind', required: false, enum: ['income', 'expense']})
  @ApiQuery({name: 'includeInactive', required: false, type: Boolean})
  async getCategories(
    @CurrentBusiness() business: IBusiness,
    @Query('kind') kind?: 'income' | 'expense',
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.financeService.getCategories(
      business.id,
      kind,
      includeInactive === 'true',
    );
  }

  @Post('finance/categories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Create a finance category'})
  async createCategory(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateFinanceCategoryDto,
  ) {
    const category = await this.financeService.createCategory(business.id, dto);
    return {message: 'Category created', category};
  }

  @Patch('finance/categories/:id')
  @ApiOperation({summary: 'Update a category (name / soft-delete)'})
  @ApiParam({name: 'id', description: 'Category ID'})
  async updateCategory(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateFinanceCategoryDto,
  ) {
    const category = await this.financeService.updateCategory(
      business.id,
      id,
      dto,
    );
    return {message: 'Category updated', category};
  }

  // ─── Transactions (Tranzaksiyalar) ────────────────────────────────────────
  @Get('finance/transactions')
  @ApiOperation({summary: 'List transactions + summary (filters, paging)'})
  async getTransactions(
    @CurrentBusiness() business: IBusiness,
    @Query() query: QueryTransactionsDto,
  ) {
    return this.financeService.getTransactions(business.id, query);
  }

  @Post('finance/transactions/income')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Record an income transaction'})
  async createIncome(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateTransactionDto,
  ) {
    const transaction = await this.financeService.createIncome(
      business.id,
      dto,
      account,
    );
    return {message: 'Income recorded', transaction};
  }

  @Post('finance/transactions/expense')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Record an expense transaction'})
  async createExpense(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateTransactionDto,
  ) {
    const transaction = await this.financeService.createExpense(
      business.id,
      dto,
      account,
    );
    return {message: 'Expense recorded', transaction};
  }

  @Post('finance/transactions/transfer')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Transfer between accounts (same currency)'})
  async createTransfer(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateTransferDto,
  ) {
    const transaction = await this.financeService.createTransfer(
      business.id,
      dto,
      account,
    );
    return {message: 'Transfer recorded', transaction};
  }
}

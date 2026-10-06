import {Controller, Get, Param, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount} from '../business/types';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import {MobileService} from './mobile.service';
import {
  MobileHomeQueryDto,
  MobileSalesDaysQueryDto,
  MobileStockQueryDto,
} from './dto/mobile-query.dto';

// Aggregates for the owner's phone UI (MOBILE.md §11). Each one answers a whole
// phone screen in one round-trip; blocks a role may not see come back null.
@ApiTags('mobile')
@Controller('mobile')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  @Get('home')
  @RequirePermission('report:view')
  @ApiOperation({summary: 'Phone home: period totals vs the same stretch before, attention signals'})
  home(@CurrentAccount() account: IAccount, @Query() q: MobileHomeQueryDto) {
    return this.mobile.getHome(account, q.period ?? 'today');
  }

  @Get('money')
  @ApiOperation({summary: 'Phone "Pul": balances, tills, who owes whom, month expenses'})
  money(@CurrentAccount() account: IAccount) {
    return this.mobile.getMoney(account);
  }

  @Get('debtors')
  @RequirePermission('debt:read')
  @ApiOperation({summary: 'Customers who owe us, overdue first'})
  debtors(@CurrentAccount() account: IAccount) {
    return this.mobile.getDebtors(account.businessId);
  }

  @Get('payables')
  @RequirePermission('receipt:read')
  @ApiOperation({summary: 'What we still owe each supplier (UZS)'})
  payables(@CurrentAccount() account: IAccount) {
    return this.mobile.getPayables(account.businessId);
  }

  @Get('expense-categories')
  @RequirePermission('finance:manage')
  @ApiOperation({summary: 'Expense categories, most used in 90 days first'})
  expenseCategories(@CurrentAccount() account: IAccount) {
    return this.mobile.getExpenseCategories(account.businessId);
  }

  @Get('products/:id')
  @ApiOperation({summary: 'Product card: prices, per-branch stock, last delivery, 30-day sales'})
  product(@CurrentAccount() account: IAccount, @Param('id') id: string) {
    return this.mobile.getProduct(account, id);
  }

  @Get('sales/days')
  @RequirePermission('sale:read')
  @ApiOperation({summary: 'Receipt count + sum per business day, GET /orders filters'})
  salesDays(
    @CurrentAccount() account: IAccount,
    @Query() q: MobileSalesDaysQueryDto,
  ) {
    return this.mobile.getSalesDays(account.businessId, q);
  }

  @Get('stock-summary')
  @RequirePermission('report:view')
  @ApiOperation({summary: 'Stock value by category (cost needs report:profit:view)'})
  stockSummary(
    @CurrentAccount() account: IAccount,
    @Query() q: MobileStockQueryDto,
  ) {
    return this.mobile.getStockSummary(account, q.branchId);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount, IBusiness} from '../business/types';
import {PayrollService} from './payroll.service';
import {AccruePeriodDto} from './dto/accrue-period.dto';
import {CreatePaymentDto} from './dto/create-payment.dto';
import {CreateAdjustmentDto} from './dto/create-adjustment.dto';
import {UpdatePayrollSettingsDto} from './dto/update-settings.dto';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';

/**
 * Payroll ("Ish haqi") lives under Moliya. Every write is owner-only: salaries
 * are not something a cashier with finance access should be able to move.
 */
@ApiTags('payroll')
@Controller('payroll')
@UseGuards(JwtAuthGuard, PlanTierGuard, PermissionsGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class PayrollController {
  constructor(private readonly payrollService: PayrollService) {}

  @Get('summary')
  @RequirePermission('payroll:view')
  @ApiOperation({
    summary: 'Per-employee salary setup, running balance and period totals',
  })
  @ApiQuery({name: 'period', required: false, description: "YYYY-MM"})
  async summary(
    @CurrentBusiness() business: IBusiness,
    @Query('period') period?: string,
  ) {
    return this.payrollService.getSummary(business.id, period);
  }

  @Get('settings')
  @RequirePermission('payroll:view')
  @ApiOperation({summary: 'Payroll preferences (auto-accrual switch)'})
  async settings(@CurrentBusiness() business: IBusiness) {
    return this.payrollService.getSettings(business.id);
  }

  @Put('settings')
  @RequirePermission('payroll:manage')
  @ApiOperation({summary: 'Update payroll preferences'})
  async updateSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdatePayrollSettingsDto,
  ) {
    return this.payrollService.updateSettings(business.id, dto);
  }

  @Get('periods/:period/preview')
  @RequirePermission('payroll:view')
  @ApiOperation({
    summary: 'Dry-run the monthly accrual — computes wages without writing',
  })
  @ApiParam({name: 'period', description: 'YYYY-MM', example: '2026-07'})
  async preview(
    @CurrentBusiness() business: IBusiness,
    @Param('period') period: string,
  ) {
    return this.payrollService.previewPeriod(business.id, period);
  }

  @Post('periods/:period/accrue')
  @RequirePermission('payroll:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Commit the monthly accrual (idempotent per employee + month)',
  })
  @ApiParam({name: 'period', description: 'YYYY-MM', example: '2026-07'})
  async accrue(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('period') period: string,
    @Body() dto: AccruePeriodDto,
  ) {
    return this.payrollService.accruePeriod(
      business.id,
      period,
      dto.staffIds,
      account,
    );
  }

  @Get('staff/:id/entries')
  @RequirePermission('payroll:view')
  @ApiOperation({summary: 'Ledger history for one employee'})
  @ApiParam({name: 'id', description: 'Staff ID'})
  @ApiQuery({name: 'limit', required: false})
  async entries(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.payrollService.getEntries(
      business.id,
      id,
      limit ? Number(limit) : undefined,
    );
  }

  @Post('staff/:id/payments')
  @RequirePermission('payroll:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pay wages or an advance — also posts a finance expense',
  })
  @ApiParam({name: 'id', description: 'Staff ID'})
  async pay(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: CreatePaymentDto,
  ) {
    return this.payrollService.recordPayment(
      business.id,
      id,
      {
        amount: dto.amount,
        accountId: dto.accountId,
        type: dto.type ?? 'payment',
        note: dto.note,
      },
      account,
    );
  }

  @Post('staff/:id/adjustments')
  @RequirePermission('payroll:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Record a bonus (mukofot) or withholding (jarima)'})
  @ApiParam({name: 'id', description: 'Staff ID'})
  async adjust(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: CreateAdjustmentDto,
  ) {
    return this.payrollService.recordAdjustment(business.id, id, dto, account);
  }

  @Delete('entries/:id')
  @RequirePermission('payroll:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Undo a ledger entry (reverses the balance and any money moved)',
  })
  @ApiParam({name: 'id', description: 'Payroll entry ID'})
  async remove(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    await this.payrollService.removeEntry(business.id, id, account);
    return {message: 'Payroll entry removed'};
  }
}

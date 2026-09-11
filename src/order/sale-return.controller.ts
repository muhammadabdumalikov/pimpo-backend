import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount, IBusiness} from '../business/types';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import {SaleReturnService} from './sale-return.service';
import {CreateSaleReturnDto, PreviewSaleReturnDto} from './dto/sale-return.dto';

@ApiTags('returns')
@Controller('returns')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class SaleReturnController {
  constructor(private readonly returns: SaleReturnService) {}

  @Get('lookup')
  @RequirePermission('sale:return')
  @ApiOperation({
    summary:
      'Find a sale by receipt number ("1245", "#1245", "R1245") or legacy ' +
      '8-char id prefix, with returnable quantities and its return history',
  })
  @ApiQuery({name: 'ref', required: true})
  lookup(@CurrentBusiness() business: IBusiness, @Query('ref') ref: string) {
    return this.returns.lookup(business.id, ref);
  }

  @Post('preview')
  @RequirePermission('sale:return')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Price a return without saving: value, debt write-down, points given ' +
      'back, money to refund and the default refund method',
  })
  preview(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: PreviewSaleReturnDto,
  ) {
    return this.returns.preview(business.id, dto);
  }

  @Post()
  @RequirePermission('sale:return')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Return lines of a completed sale: restock (or mark defective), settle ' +
      'debt → points → money out of the open shift, and log the history',
  })
  create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateSaleReturnDto,
  ) {
    return this.returns.create(business.id, dto, account);
  }

  @Get()
  @RequirePermission('sale:read')
  @ApiOperation({summary: 'Return history (newest first)'})
  @ApiQuery({name: 'page', required: false})
  @ApiQuery({name: 'limit', required: false})
  @ApiQuery({name: 'from', required: false, description: 'YYYY-MM-DD'})
  @ApiQuery({name: 'to', required: false, description: 'YYYY-MM-DD'})
  @ApiQuery({name: 'orderId', required: false})
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Receipt number, customer, cashier or reason',
  })
  findAll(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('orderId') orderId?: string,
    @Query('search') search?: string,
  ) {
    return this.returns.findAll(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      from,
      to,
      orderId,
      search,
    });
  }

  @Get(':id')
  @RequirePermission('sale:read')
  @ApiOperation({summary: 'One return with its lines'})
  findOne(@CurrentBusiness() business: IBusiness, @Param('id') id: string) {
    return this.returns.findOne(business.id, id);
  }
}

import {
  Body,
  Controller,
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
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IAccount, IBusiness} from '../business/types';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import {OnlineOrderService} from './online-order.service';
import {StoreSettingsService} from './store-settings.service';
import {
  ArrivalDto,
  CancelOnlineOrderDto,
  CompleteOnlineOrderDto,
  CreateManualOnlineOrderDto,
  DepositDto,
  DispatchOnlineOrderDto,
  UpdateOnlineOrderItemsDto,
  UpdateStoreDeliveryDto,
} from './dto/online-order.dto';
import {ONLINE_GROUPS, type OnlineGroup} from './online-order.rules';

const groupOf = (v?: string): OnlineGroup =>
  v && (v === 'all' || v in ONLINE_GROUPS) ? (v as OnlineGroup) : 'all';

/** Storefront orders after checkout (YETKAZISH.md §4.1). */
@ApiTags('online-orders')
@Controller('online-orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('sale:online:manage')
@ApiBearerAuth('JWT-auth')
export class OnlineOrderController {
  constructor(private readonly online: OnlineOrderService) {}

  @Get()
  @ApiOperation({summary: 'List storefront orders by work group'})
  @ApiQuery({
    name: 'group',
    required: false,
    enum: ['new', 'awaiting', 'inwork', 'active', 'done', 'cancelled', 'all'],
  })
  @ApiQuery({name: 'search', required: false})
  @ApiQuery({name: 'page', required: false})
  @ApiQuery({name: 'limit', required: false})
  list(
    @CurrentBusiness() business: IBusiness,
    @Query('group') group?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.online.list(business.id, {
      group: groupOf(group),
      search,
      page: page ? parseInt(page, 10) || 1 : undefined,
      limit: limit ? parseInt(limit, 10) || 50 : undefined,
    });
  }

  @Get('counts')
  @ApiOperation({
    summary: 'How many storefront orders wait (new) or are in progress',
  })
  counts(@CurrentBusiness() business: IBusiness) {
    return this.online.counts(business.id);
  }

  @Get('awaiting-stock')
  @ApiOperation({
    summary: 'What the waiting orders need, per product ("Tovar keldi")',
  })
  awaitingStock(@CurrentBusiness() business: IBusiness) {
    return this.online.awaitingStock(business.id);
  }

  @Post()
  @ApiOperation({summary: 'Type in an order taken in a DM (starts accepted)'})
  createManual(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateManualOnlineOrderDto,
  ) {
    return this.online.createManual(business.id, account, dto);
  }

  @Post('arrivals')
  @ApiOperation({
    summary:
      'Goods for waiting orders arrived: receive them (cost + cargo), optionally paid from an account',
  })
  arrivals(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: ArrivalDto,
  ) {
    return this.online.receiveArrival(business.id, account, dto);
  }

  @Get(':id')
  @ApiParam({name: 'id'})
  @ApiOperation({summary: 'One storefront order with lines and status history'})
  detail(@CurrentBusiness() business: IBusiness, @Param('id') id: string) {
    return this.online.detail(business.id, id);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Accept: the order starts being assembled'})
  accept(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    return this.online.accept(business.id, id, account);
  }

  @Post(':id/deposits')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Take a deposit (zaklad) before hand-over'})
  addDeposit(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: DepositDto,
  ) {
    return this.online.addDeposit(business.id, id, account, dto);
  }

  @Post(':id/dispatch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'A delivery order leaves with a courier'})
  dispatch(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: DispatchOnlineOrderDto,
  ) {
    return this.online.dispatch(business.id, id, account, dto.courierId);
  }

  @Post(':id/ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'A pickup order is ready to be collected'})
  ready(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    return this.online.ready(business.id, id, account);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Handed over and paid: the order becomes a sale today',
  })
  complete(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: CompleteOnlineOrderDto,
  ) {
    return this.online.complete(business.id, id, account, dto.payments);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel with a reason; the goods go back on the shelf',
  })
  cancel(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: CancelOnlineOrderDto,
  ) {
    return this.online.cancel(
      business.id,
      id,
      account,
      dto.reason,
      dto.note,
      dto.deposit ?? 'refund',
    );
  }

  @Put(':id/items')
  @ApiOperation({
    summary: 'Trim lines while assembling (quantities only go down)',
  })
  updateItems(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: UpdateOnlineOrderItemsDto,
  ) {
    return this.online.updateItems(business.id, id, account, dto.items);
  }
}

/** Settings → Online store → handing orders over (YETKAZISH.md §4.2). */
@ApiTags('online-orders')
@Controller('businesses/me/store/delivery')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('settings:manage')
@ApiBearerAuth('JWT-auth')
export class StoreDeliverySettingsController {
  constructor(private readonly settings: StoreSettingsService) {}

  @Get()
  @ApiOperation({summary: 'Pickup / delivery settings of the storefront'})
  get(@CurrentBusiness() business: IBusiness) {
    return this.settings.get(business.id);
  }

  @Put()
  @ApiOperation({summary: 'Update pickup / delivery settings (partial)'})
  update(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateStoreDeliveryDto,
  ) {
    return this.settings.update(business.id, dto);
  }
}

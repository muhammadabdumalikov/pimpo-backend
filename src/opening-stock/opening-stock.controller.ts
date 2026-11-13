import {
  Body,
  Controller,
  Get,
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
import {OpeningStockService} from './opening-stock.service';
import {
  CreateOpeningStockDto,
  UpsertOpeningStockItemsDto,
} from './dto/opening-stock.dto';

// "Boshlang'ich qoldiq" documents (FILIAL-ASSORTIMENT.md). Open on every tier
// (Q15); writes need the stock-take permission (Q8).
@ApiTags('opening-stocks')
@Controller('opening-stocks')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class OpeningStockController {
  constructor(private readonly service: OpeningStockService) {}

  @Get()
  @ApiOperation({summary: 'List opening stock documents'})
  @ApiQuery({name: 'branchId', required: false})
  @ApiQuery({name: 'status', required: false})
  @ApiQuery({name: 'page', required: false, type: Number})
  @ApiQuery({name: 'limit', required: false, type: Number})
  async list(
    @CurrentBusiness() business: IBusiness,
    @Query('branchId') branchId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list(business.id, {
      branchId: branchId || undefined,
      status: status || undefined,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({summary: 'One opening stock document with its lines'})
  @ApiParam({name: 'id'})
  async getOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.service.getOne(business.id, id);
  }

  @Post()
  @RequirePermission('stocktake:manage')
  @ApiOperation({summary: 'Start a draft opening stock document'})
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateOpeningStockDto,
  ) {
    return this.service.create(business.id, dto, account);
  }

  @Put(':id/items')
  @RequirePermission('stocktake:manage')
  @ApiOperation({
    summary: 'Upsert counted lines (absolute quantity; <= 0 removes)',
  })
  @ApiParam({name: 'id'})
  async upsertItems(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpsertOpeningStockItemsDto,
  ) {
    return this.service.upsertItems(business.id, id, dto);
  }

  @Post(':id/complete')
  @RequirePermission('stocktake:manage')
  @ApiOperation({summary: 'Complete: add the stock (capital or transfer)'})
  @ApiParam({name: 'id'})
  async complete(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
  ) {
    return this.service.complete(business.id, id, account);
  }

  @Post(':id/cancel')
  @RequirePermission('stocktake:manage')
  @ApiOperation({summary: 'Cancel a draft'})
  @ApiParam({name: 'id'})
  async cancel(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.service.cancel(business.id, id);
  }
}

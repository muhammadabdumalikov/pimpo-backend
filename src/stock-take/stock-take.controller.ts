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
import {StockTakeService} from './stock-take.service';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IBusiness, IAccount} from '../business/types';
import {CreateStockTakeDto} from './dto/create-stock-take.dto';
import {CountItemsDto} from './dto/count-items.dto';
import {CheckItemsDto} from './dto/check-items.dto';
import {CompleteStockTakeDto} from './dto/complete-stock-take.dto';
import {CreateWriteOffDto} from './dto/create-write-off.dto';

@ApiTags('stock-takes')
@Controller('stock-takes')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class StockTakeController {
  constructor(private readonly stockTakeService: StockTakeService) {}

  @Get()
  @ApiOperation({summary: 'List stock-takes (paginated)'})
  @ApiQuery({name: 'page', required: false, type: Number})
  @ApiQuery({name: 'limit', required: false, type: Number})
  async list(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.stockTakeService.list(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({summary: 'A single stock-take with its counted rows'})
  @ApiParam({name: 'id', description: 'Stock-take ID'})
  async getOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.stockTakeService.getOne(business.id, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Start a stock-take (full snapshots the catalog)'})
  async start(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateStockTakeDto,
  ) {
    const stockTake = await this.stockTakeService.start(
      business.id,
      dto,
      account,
    );
    return {message: 'Stock-take started', stockTake};
  }

  @Patch(':id/count')
  @ApiOperation({summary: 'Upsert counted quantities for scanned products'})
  @ApiParam({name: 'id', description: 'Stock-take ID'})
  async count(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: CountItemsDto,
  ) {
    return this.stockTakeService.count(business.id, id, dto);
  }

  @Patch(':id/check')
  @ApiOperation({
    summary: 'Toggle the reviewed ("tekshirildi") flag on counted rows',
  })
  @ApiParam({name: 'id', description: 'Stock-take ID'})
  async check(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: CheckItemsDto,
  ) {
    return this.stockTakeService.setChecked(business.id, id, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finalize: adjust stock + batches (FIFO), write finance diff',
  })
  @ApiParam({name: 'id', description: 'Stock-take ID'})
  async complete(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: CompleteStockTakeDto,
  ) {
    const stockTake = await this.stockTakeService.complete(
      business.id,
      id,
      dto,
      account,
    );
    return {message: 'Stock-take completed', stockTake};
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an in-progress count: drop its rows, release the freeze',
  })
  @ApiParam({name: 'id', description: 'Stock-take ID'})
  async cancel(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const stockTake = await this.stockTakeService.cancel(business.id, id);
    return {message: 'Stock-take cancelled', stockTake};
  }
}

// Write-off ("hisobdan chiqarish") — the simplified, count-free stock reduction.
// Separate route per INVENTARIZATSIYA.md §6; delegates to StockTakeService,
// which records it as a completed stock_take of type 'writeoff'.
@ApiTags('write-offs')
@Controller('write-offs')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class WriteOffController {
  constructor(private readonly stockTakeService: StockTakeService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Write off stock immediately (FIFO reduce + expense)',
  })
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateWriteOffDto,
  ) {
    const stockTake = await this.stockTakeService.writeOff(
      business.id,
      dto,
      account,
    );
    return {message: 'Write-off recorded', stockTake};
  }
}

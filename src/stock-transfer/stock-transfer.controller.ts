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
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import {StockTransferService} from './stock-transfer.service';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IBusiness, IAccount} from '../business/types';
import {CreateStockTransferDto} from './dto/create-stock-transfer.dto';

@ApiTags('stock-transfers')
@Controller('stock-transfers')
@UseGuards(JwtAuthGuard, PlanTierGuard)
@MinTier('basic')
@ApiBearerAuth('JWT-auth')
export class StockTransferController {
  constructor(private readonly transferService: StockTransferService) {}

  @Get()
  @ApiOperation({summary: 'List stock transfers (paginated)'})
  @ApiQuery({name: 'page', required: false, type: Number})
  @ApiQuery({name: 'limit', required: false, type: Number})
  async list(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transferService.list(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({summary: 'A single transfer with its moved rows'})
  @ApiParam({name: 'id', description: 'Transfer ID'})
  async getOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.transferService.getOne(business.id, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Move stock (and its batches) from one branch to another',
  })
  async create(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: CreateStockTransferDto,
  ) {
    const transfer = await this.transferService.create(
      business.id,
      dto,
      account,
    );
    return {message: 'Transfer recorded', transfer};
  }
}

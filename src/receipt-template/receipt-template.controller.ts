import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiQuery, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {ReceiptTemplateService} from './receipt-template.service';
import {CreateReceiptTemplateDto} from './dto/create-receipt-template.dto';
import {UpdateReceiptTemplateDto} from './dto/update-receipt-template.dto';

@ApiTags('receipt-templates')
@Controller('receipt-templates')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ReceiptTemplateController {
  constructor(private readonly service: ReceiptTemplateService) {}

  @Get()
  @ApiOperation({summary: 'List receipt templates'})
  findAll(@CurrentBusiness() business: IBusiness) {
    return this.service.findAll(business.id);
  }

  // Must be declared before the ':id' route so 'resolve' is not captured by it.
  @Get('resolve')
  @ApiOperation({summary: 'Resolve the template for a register (or default)'})
  @ApiQuery({name: 'registerId', required: false})
  resolve(
    @CurrentBusiness() business: IBusiness,
    @Query('registerId') registerId?: string,
  ) {
    return this.service.resolve(business.id, registerId);
  }

  @Get(':id')
  @ApiOperation({summary: 'Get a receipt template'})
  findOne(@CurrentBusiness() business: IBusiness, @Param('id') id: string) {
    return this.service.findOne(business.id, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Create a receipt template'})
  create(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateReceiptTemplateDto,
  ) {
    return this.service.create(business.id, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update a receipt template'})
  update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateReceiptTemplateDto,
  ) {
    return this.service.update(business.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Delete a receipt template (not the default)'})
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.service.remove(business.id, id);
    return {message: 'Receipt template deleted successfully'};
  }
}

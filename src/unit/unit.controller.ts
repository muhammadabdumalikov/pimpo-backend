import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { UnitService } from './unit.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';

@ApiTags('units')
@Controller('units')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class UnitController {
  constructor(private readonly unitService: UnitService) {}

  @Get()
  @ApiOperation({ summary: "List units of measure (o'lchov birliklari)" })
  @ApiResponse({ status: 200, description: 'Units returned' })
  async findAll(@CurrentBusiness() business: IBusiness) {
    const list = await this.unitService.findAll(business.id);
    return { units: list };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a unit' })
  @ApiResponse({ status: 201, description: 'Unit created' })
  @ApiResponse({ status: 409, description: 'Unit name already exists' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateUnitDto,
  ) {
    return this.unitService.create(business.id, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a unit' })
  @ApiParam({ name: 'id', description: 'Unit id' })
  @ApiResponse({ status: 200, description: 'Unit updated' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.unitService.update(business.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deactivate a unit' })
  @ApiParam({ name: 'id', description: 'Unit id' })
  @ApiResponse({ status: 204, description: 'Unit deactivated' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.unitService.remove(business.id, id);
  }
}

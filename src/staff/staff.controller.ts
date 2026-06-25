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
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { OwnerGuard } from '../business/owner.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { StaffService } from './staff.service';

@ApiTags('staff')
@Controller('staff')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  @ApiOperation({ summary: 'Get all staff for current business' })
  @ApiResponse({ status: 200, description: 'List of staff' })
  async findAll(@CurrentBusiness() business: IBusiness) {
    return this.staffService.findAll(business.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get staff by id' })
  @ApiParam({ name: 'id', description: 'Staff ID' })
  @ApiResponse({ status: 200, description: 'Staff' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    const member = await this.staffService.findOne(business.id, id);
    if (!member) throw new NotFoundException('Staff not found');
    return member;
  }

  @Post()
  @UseGuards(OwnerGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a staff account (owner only)' })
  @ApiResponse({ status: 201, description: 'Staff created' })
  @ApiResponse({ status: 409, description: 'Login already exists' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateStaffDto,
  ) {
    return this.staffService.create(business.id, dto);
  }

  @Put(':id')
  @UseGuards(OwnerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a staff account (owner only)' })
  @ApiParam({ name: 'id', description: 'Staff ID' })
  @ApiResponse({ status: 200, description: 'Staff updated' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.staffService.update(business.id, id, dto);
  }

  @Delete(':id')
  @UseGuards(OwnerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a staff account (owner only)' })
  @ApiParam({ name: 'id', description: 'Staff ID' })
  @ApiResponse({ status: 200, description: 'Staff deleted' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.staffService.remove(business.id, id);
    return { message: 'Staff deleted successfully' };
  }
}

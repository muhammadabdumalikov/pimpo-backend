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
import {ShiftService} from './shift.service';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {CurrentAccount} from '../business/decorators/current-account.decorator';
import {IBusiness, IAccount} from '../business/types';
import {CreateRegisterDto} from './dto/create-register.dto';
import {UpdateRegisterDto} from './dto/update-register.dto';
import {CreateCashCategoryDto} from './dto/create-cash-category.dto';
import {UpdateCashCategoryDto} from './dto/update-cash-category.dto';
import {OpenShiftDto} from './dto/open-shift.dto';
import {CreateCashMovementDto} from './dto/create-cash-movement.dto';
import {CloseShiftDto} from './dto/close-shift.dto';

@ApiTags('shifts')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ShiftController {
  constructor(private readonly shiftService: ShiftService) {}

  // ─── Registers (kassa) ────────────────────────────────────────────────────
  @Get('registers')
  @ApiOperation({summary: 'List cash registers (kassa) for current business'})
  async getRegisters(@CurrentBusiness() business: IBusiness) {
    return this.shiftService.getRegisters(business.id);
  }

  @Post('registers')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Create a cash register (kassa)'})
  async createRegister(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateRegisterDto,
  ) {
    const register = await this.shiftService.createRegister(business.id, dto);
    return {message: 'Register created', register};
  }

  @Patch('registers/:id')
  @ApiOperation({summary: 'Update a cash register (name / active)'})
  @ApiParam({name: 'id', description: 'Register ID'})
  async updateRegister(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateRegisterDto,
  ) {
    const register = await this.shiftService.updateRegister(
      business.id,
      id,
      dto,
    );
    return {message: 'Register updated', register};
  }

  // ─── Cash operation categories (Toifa) ────────────────────────────────────
  @Get('cash-categories')
  @ApiOperation({summary: 'List cash operation categories'})
  async getCashCategories(@CurrentBusiness() business: IBusiness) {
    return this.shiftService.getCashCategories(business.id);
  }

  @Post('cash-categories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Create a cash operation category'})
  async createCashCategory(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateCashCategoryDto,
  ) {
    const category = await this.shiftService.createCashCategory(
      business.id,
      dto,
    );
    return {message: 'Category created', category};
  }

  @Patch('cash-categories/:id')
  @ApiOperation({summary: 'Update / soft-delete a cash operation category'})
  @ApiParam({name: 'id', description: 'Category ID'})
  async updateCashCategory(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateCashCategoryDto,
  ) {
    const category = await this.shiftService.updateCashCategory(
      business.id,
      id,
      dto,
    );
    return {message: 'Category updated', category};
  }

  // ─── Shifts ───────────────────────────────────────────────────────────────
  @Get('shifts/current')
  @ApiOperation({summary: 'Open shift for a register (null if none)'})
  @ApiQuery({name: 'registerId', required: true, type: String})
  async getCurrentShift(
    @CurrentBusiness() business: IBusiness,
    @Query('registerId') registerId: string,
  ) {
    return this.shiftService.getCurrentShift(business.id, registerId);
  }

  @Get('shifts/open')
  @ApiOperation({summary: 'All currently open shifts (one per register)'})
  async getOpenShifts(@CurrentBusiness() business: IBusiness) {
    return this.shiftService.getOpenShifts(business.id);
  }

  @Post('shifts/open')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Open a shift on a register (with opening float)'})
  async openShift(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Body() dto: OpenShiftDto,
  ) {
    const shift = await this.shiftService.openShift(business.id, dto, account);
    return {message: 'Shift opened', shift};
  }

  @Get('shifts')
  @ApiOperation({summary: 'Shift history (paginated)'})
  @ApiQuery({name: 'page', required: false, type: Number})
  @ApiQuery({name: 'limit', required: false, type: Number})
  @ApiQuery({name: 'registerId', required: false, type: String})
  async getShifts(
    @CurrentBusiness() business: IBusiness,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('registerId') registerId?: string,
  ) {
    return this.shiftService.getShifts(business.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      registerId,
    });
  }

  @Post('shifts/:id/movements')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Add a cash movement (kirim/chiqim) to a shift'})
  @ApiParam({name: 'id', description: 'Shift ID'})
  async addMovement(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: CreateCashMovementDto,
  ) {
    const movement = await this.shiftService.addMovement(
      business.id,
      id,
      dto,
      account,
    );
    return {message: 'Movement recorded', movement};
  }

  @Get('shifts/:id/movements')
  @ApiOperation({summary: "List a shift's cash movements"})
  @ApiParam({name: 'id', description: 'Shift ID'})
  async getMovements(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.shiftService.getShiftMovements(business.id, id);
  }

  @Get('shifts/:id/report')
  @ApiOperation({summary: 'X-report: live reconciliation without closing'})
  @ApiParam({name: 'id', description: 'Shift ID'})
  async getReport(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.shiftService.getShiftReport(business.id, id);
  }

  @Post('shifts/:id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Close a shift → Z-report (per method × currency)'})
  @ApiParam({name: 'id', description: 'Shift ID'})
  async closeShift(
    @CurrentBusiness() business: IBusiness,
    @CurrentAccount() account: IAccount,
    @Param('id') id: string,
    @Body() dto: CloseShiftDto,
  ) {
    const shift = await this.shiftService.closeShift(
      business.id,
      id,
      dto,
      account,
    );
    return {message: 'Shift closed', shift};
  }

  @Get('shifts/:id')
  @ApiOperation({summary: 'A single shift by ID'})
  @ApiParam({name: 'id', description: 'Shift ID'})
  async getShift(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    return this.shiftService.getShift(business.id, id);
  }
}

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
import { PaymentMethodService } from './payment-method.service';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import {
  CreatePaymentMethodDto,
  UpdatePaymentMethodDto,
} from './dto/payment-method.dto';

@ApiTags('payment-methods')
@Controller('payment-methods')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class PaymentMethodController {
  constructor(private readonly paymentMethodService: PaymentMethodService) {}

  @Get()
  @ApiOperation({ summary: "List payment methods (to'lov turlari)" })
  @ApiResponse({ status: 200, description: 'Payment methods returned' })
  async findAll(@CurrentBusiness() business: IBusiness) {
    const list = await this.paymentMethodService.findAll(business.id);
    return { paymentMethods: list };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a custom payment method' })
  @ApiResponse({ status: 201, description: 'Payment method created' })
  @ApiResponse({ status: 409, description: 'Name already exists' })
  async create(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreatePaymentMethodDto,
  ) {
    return this.paymentMethodService.create(business.id, dto);
  }

  @Put(':id')
  @ApiOperation({
    summary:
      'Update a payment method (system rows: visibility/order only)',
  })
  @ApiParam({ name: 'id', description: 'Payment method id' })
  @ApiResponse({ status: 200, description: 'Payment method updated' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdatePaymentMethodDto,
  ) {
    return this.paymentMethodService.update(business.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a custom payment method' })
  @ApiParam({ name: 'id', description: 'Payment method id' })
  @ApiResponse({ status: 204, description: 'Payment method deleted' })
  async remove(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.paymentMethodService.remove(business.id, id);
  }
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  IsNumber,
  IsDateString,
  Min,
  ArrayMinSize,
  ValidateNested,
  IsIn,
} from 'class-validator';

export class OrderItemDto {
  @ApiProperty({ description: 'Product id' })
  @IsString()
  productId: string;

  @ApiProperty({ description: 'Quantity ordered', example: 2 })
  @IsInt()
  @Min(1)
  quantity: number;
}

export class PaymentSplitDto {
  @ApiProperty({ description: 'Payment method', enum: ['cash', 'card'] })
  @IsString()
  @IsIn(['cash', 'card'])
  method: string;

  @ApiProperty({ description: 'Amount applied via this method' })
  @IsNumber()
  @Min(0)
  amount: number;
}

export class CreateOrderDto {
  @ApiProperty({ description: 'Order line items', type: [OrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiProperty({ description: 'Customer id (optional)', required: false })
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiProperty({ description: 'Customer name snapshot (optional)', required: false })
  @IsString()
  @IsOptional()
  customerName?: string;

  @ApiProperty({
    description: 'Order status',
    required: false,
    enum: ['Pending', 'Completed', 'Cancelled'],
  })
  @IsString()
  @IsIn(['Pending', 'Completed', 'Cancelled'])
  @IsOptional()
  status?: string;

  @ApiProperty({ description: 'Payment method', required: false })
  @IsString()
  @IsOptional()
  paymentMethod?: string;

  @ApiPropertyOptional({
    description: 'Per-method payment breakdown (for split payments)',
    type: [PaymentSplitDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PaymentSplitDto)
  payments?: PaymentSplitDto[];

  @ApiPropertyOptional({ description: 'Cash physically tendered by the customer' })
  @IsNumber()
  @IsOptional()
  @Min(0)
  amountPaid?: number;

  @ApiPropertyOptional({
    description: 'Customer phone (for a debt sale: find-or-create the customer)',
  })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({
    description: 'Debt due date (ISO). Required when paymentMethod is "debt".',
  })
  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @ApiPropertyOptional({
    description: 'Whole-receipt manual discount type',
    enum: ['amount', 'percent'],
  })
  @IsString()
  @IsIn(['amount', 'percent'])
  @IsOptional()
  discountType?: string;

  @ApiPropertyOptional({
    description:
      'Discount value: a fixed soʻm amount, or a percent (0-100) when discountType is "percent"',
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  discountValue?: number;

  @ApiProperty({ description: 'Note', required: false })
  @IsString()
  @IsOptional()
  note?: string;

  @ApiProperty({
    description: 'Order source',
    required: false,
    enum: ['admin', 'store'],
  })
  @IsString()
  @IsIn(['admin', 'store'])
  @IsOptional()
  source?: string;
}

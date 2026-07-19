import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
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
  IsUUID,
} from 'class-validator';

export class OrderItemDto {
  @ApiProperty({description: 'Product id'})
  @IsString()
  productId: string;

  @ApiProperty({description: 'Quantity ordered', example: 2})
  @IsInt()
  @Min(1)
  quantity: number;
}

export class PaymentSplitDto {
  @ApiProperty({description: 'Payment method', enum: ['cash', 'card']})
  @IsString()
  @IsIn(['cash', 'card'])
  method: string;

  @ApiProperty({description: 'Amount applied via this method'})
  @IsNumber()
  @Min(0)
  amount: number;
}

export class CreateOrderDto {
  @ApiProperty({description: 'Order line items', type: [OrderItemDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiPropertyOptional({
    description:
      'Client-generated idempotency key (UUID) for offline sales. Re-POSTing ' +
      'the same clientId returns the already-created order instead of a duplicate.',
  })
  @IsUUID()
  @IsOptional()
  clientId?: string;

  @ApiProperty({description: 'Customer id (optional)', required: false})
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiPropertyOptional({
    description:
      "Branch (do'kon) the sale belongs to. Defaults to the business default " +
      'branch when omitted.',
  })
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiProperty({
    description: 'Customer name snapshot (optional)',
    required: false,
  })
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

  @ApiProperty({description: 'Payment method', required: false})
  @IsString()
  @IsOptional()
  paymentMethod?: string;

  @ApiPropertyOptional({
    description: 'Per-method payment breakdown (for split payments)',
    type: [PaymentSplitDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({each: true})
  @Type(() => PaymentSplitDto)
  payments?: PaymentSplitDto[];

  @ApiPropertyOptional({
    description: 'Cash physically tendered by the customer',
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  amountPaid?: number;

  @ApiPropertyOptional({
    description:
      'Customer phone (for a debt sale: find-or-create the customer)',
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

  @ApiProperty({description: 'Note', required: false})
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

  @ApiPropertyOptional({
    description:
      'Register (kassa) this admin sale is rung up on. If omitted and the ' +
      'business has exactly one register, that one is used. Ignored for store sales.',
  })
  @IsString()
  @IsOptional()
  registerId?: string;

  @ApiPropertyOptional({
    description:
      'Cashier shift this sale belongs to. Normally resolved from the ' +
      "register's open shift; an offline sale may pass the shift it was rung " +
      'under so it still attributes correctly after sync.',
  })
  @IsString()
  @IsOptional()
  shiftId?: string;

  @ApiPropertyOptional({
    description:
      'Held (parked) order this sale resumes. Deleted in the same ' +
      'transaction as the new order so it cannot be resumed twice.',
  })
  @IsString()
  @IsOptional()
  heldOrderId?: string;
}

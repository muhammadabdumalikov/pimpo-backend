import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  Min,
  ArrayMinSize,
  ValidateNested,
  IsIn,
} from 'class-validator';
import {OrderItemDto} from './create-order.dto';

/**
 * Park the current cart as a held ("kechiktirilgan") sale. Only the cart
 * snapshot travels here — no payment fields, because nothing is paid yet.
 */
export class HoldOrderDto {
  @ApiProperty({description: 'Cart line items', type: [OrderItemDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiPropertyOptional({description: 'Customer id'})
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiPropertyOptional({description: 'Customer name snapshot'})
  @IsString()
  @IsOptional()
  customerName?: string;

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

  @ApiPropertyOptional({description: 'Note'})
  @IsString()
  @IsOptional()
  note?: string;
}

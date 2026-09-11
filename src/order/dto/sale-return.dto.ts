import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {PaymentSplitDto} from './create-order.dto';

export class ReturnItemDto {
  @ApiProperty({description: 'order_items.id of the line coming back'})
  @IsString()
  orderItemId!: string;

  @ApiProperty({
    description:
      'Quantity returned. Whole units for piece goods, up to 3 decimals (kg) ' +
      'for weighed goods. At most what is still returnable on the line.',
  })
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional({
    description:
      'true (default) = back on the shelf; false = defective ("yaroqsiz"), ' +
      'not restocked',
  })
  @IsBoolean()
  @IsOptional()
  restock?: boolean;
}

/** Price a return before committing it (no writes). */
export class PreviewSaleReturnDto {
  @ApiProperty({description: 'Sale being returned against'})
  @IsString()
  orderId!: string;

  @ApiProperty({type: [ReturnItemDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => ReturnItemDto)
  items!: ReturnItemDto[];
}

export class CreateSaleReturnDto extends PreviewSaleReturnDto {
  @ApiPropertyOptional({
    description:
      'How the money part is paid back, summing to the refund amount from the ' +
      "preview. Omit to refund it all via the sale's main payment method.",
    type: [PaymentSplitDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({each: true})
  @Type(() => PaymentSplitDto)
  refunds?: PaymentSplitDto[];

  @ApiPropertyOptional({description: 'Why the goods came back'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Register (kassa) the refund is paid from; resolved like a sale when ' +
      'omitted (the sole register).',
  })
  @IsString()
  @IsOptional()
  registerId?: string;

  @ApiPropertyOptional({description: 'Open shift the refund belongs to'})
  @IsString()
  @IsOptional()
  shiftId?: string;
}

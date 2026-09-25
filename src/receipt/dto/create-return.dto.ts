import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  IsIn,
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  Min,
  ArrayMinSize,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import {
  SUPPLIER_RETURN_REASONS,
  SupplierReturnReason,
} from '../../common/loss-reasons';

export class ReturnItemDto {
  @ApiProperty({description: 'Product id (must be on the receipt)'})
  @IsString()
  productId: string;

  @ApiProperty({
    description: 'Quantity to return (> 0). Fractional kg for weighed goods.',
    example: 5,
  })
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  quantity: number;

  @ApiPropertyOptional({
    enum: SUPPLIER_RETURN_REASONS,
    description: 'Why this line goes back (overrides the document reasonCode)',
  })
  @IsIn(SUPPLIER_RETURN_REASONS)
  @IsOptional()
  reasonCode?: SupplierReturnReason;

  @ApiPropertyOptional({
    description: "Line note; required when the line's reason code is 'other'",
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  note?: string;
}

/** Return received goods back to the supplier, against a goods receipt. */
export class CreateReturnDto {
  @ApiProperty({description: 'Return line items', type: [ReturnItemDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];

  @ApiPropertyOptional({
    enum: SUPPLIER_RETURN_REASONS,
    description: 'Default reason code for lines without one',
  })
  @IsIn(SUPPLIER_RETURN_REASONS)
  @IsOptional()
  reasonCode?: SupplierReturnReason;

  @ApiPropertyOptional({description: 'Note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

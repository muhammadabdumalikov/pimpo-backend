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
  MaxLength,
} from 'class-validator';

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
}

/** Return received goods back to the supplier, against a goods receipt. */
export class CreateReturnDto {
  @ApiProperty({description: 'Return line items', type: [ReturnItemDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];

  @ApiPropertyOptional({description: 'Note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

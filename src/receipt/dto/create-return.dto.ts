import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  Min,
  ArrayMinSize,
  ValidateNested,
  MaxLength,
} from 'class-validator';

export class ReturnItemDto {
  @ApiProperty({description: 'Product id (must be on the receipt)'})
  @IsString()
  productId: string;

  @ApiProperty({description: 'Quantity to return (> 0)', example: 5})
  @IsInt()
  @Min(1)
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

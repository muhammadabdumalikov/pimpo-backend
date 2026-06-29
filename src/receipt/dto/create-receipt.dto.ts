import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  IsNumber,
  Min,
  ArrayMinSize,
  ValidateNested,
  MaxLength,
} from 'class-validator';

export class ReceiptItemDto {
  @ApiProperty({ description: 'Product id' })
  @IsString()
  productId: string;

  @ApiProperty({ description: 'Quantity received', example: 100 })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiProperty({ description: 'Unit cost paid for this batch', example: 5000 })
  @IsNumber()
  @Min(0)
  priceIn: number;
}

export class CreateReceiptDto {
  @ApiProperty({ description: 'Receipt line items', type: [ReceiptItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiptItemDto)
  items: ReceiptItemDto[];

  @ApiPropertyOptional({ description: 'Supplier id (optional)' })
  @IsString()
  @IsOptional()
  supplierId?: string;

  @ApiPropertyOptional({ description: 'Note' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// Permissive row shape: rows are validated per-row in the service so one bad row
// doesn't 400 the whole import (partial success is reported instead).
export class BulkProductItemDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() priceIn?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() priceOut?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() quantityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() priceBundle?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lowStockThreshold?: number;
}

export class BulkCreateProductDto {
  @ApiProperty({
    description:
      'Products to import. Each row is validated individually; invalid/duplicate rows are reported, not fatal.',
    type: [BulkProductItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500, { message: 'At most 500 products can be imported at once' })
  @ValidateNested({ each: true })
  @Type(() => BulkProductItemDto)
  products: BulkProductItemDto[];
}

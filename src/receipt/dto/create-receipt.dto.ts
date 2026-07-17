import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  IsNumber,
  IsBoolean,
  IsIn,
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

  @ApiPropertyOptional({
    description:
      'Unit selling price for this batch. Defaults to the product current priceOut.',
    example: 6000,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  priceOut?: number;

  @ApiPropertyOptional({
    description:
      'Wholesale (bulk) selling price. When given, updates the product wholesale price.',
    example: 5500,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  priceWholesale?: number;

  @ApiPropertyOptional({
    description:
      'When the new selling price is higher than the current one, whether to ' +
      'also reprice the existing open batches up (true) or keep their old ' +
      'price (false). Overrides the business priceIncreaseMode default.',
  })
  @IsBoolean()
  @IsOptional()
  repriceExisting?: boolean;
}

export class CreateReceiptDto {
  @ApiProperty({ description: 'Receipt line items', type: [ReceiptItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiptItemDto)
  items: ReceiptItemDto[];

  @ApiPropertyOptional({
    description:
      'Save as a draft (no stock change). Receive it later to apply stock.',
  })
  @IsBoolean()
  @IsOptional()
  draft?: boolean;

  @ApiPropertyOptional({
    description: 'Supply/settlement currency of the receipt',
    enum: ['UZS', 'USD'],
    default: 'UZS',
  })
  @IsString()
  @IsIn(['UZS', 'USD'])
  @IsOptional()
  currency?: 'UZS' | 'USD';

  @ApiPropertyOptional({
    description: 'USD→UZS rate (required when currency is USD)',
    example: 12800,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  usdRate?: number;

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

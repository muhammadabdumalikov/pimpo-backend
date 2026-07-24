import {ApiProperty} from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  Min,
  MinLength,
  MaxLength,
} from 'class-validator';

export class UpdateProductDto {
  @ApiProperty({
    description: 'Product name',
    example: 'ASUS ROG Gaming Laptop',
    required: false,
  })
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'Product code',
    example: 'ASUS-001',
    required: false,
  })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiProperty({
    description: 'Product barcode (max 14 characters)',
    example: '1234567890123',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(14, {message: 'Barcode must be at most 14 characters'})
  barcode?: string;

  @ApiProperty({
    description: 'Purchase price (price in)',
    example: '1800.00',
    required: false,
  })
  @IsString()
  @IsOptional()
  priceIn?: string;

  @ApiProperty({
    description: 'Selling price (price out)',
    example: '2199.00',
    required: false,
  })
  @IsString()
  @IsOptional()
  priceOut?: string;

  @ApiProperty({
    description: 'Product quantity',
    example: 10,
    required: false,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description: 'Quantity type (kg, piece, others)',
    example: 'piece',
    required: false,
  })
  @IsString()
  @IsOptional()
  quantityType?: string;

  @ApiProperty({
    description:
      'Unit of measure id (units table). When set, quantityType is derived from the unit.',
    required: false,
  })
  @IsString()
  @IsOptional()
  unitId?: string;

  @ApiProperty({
    description: 'Product image URL',
    example: '/images/product/product-01.jpg',
    required: false,
  })
  @IsString()
  @IsOptional()
  image?: string;

  @ApiProperty({
    description: 'Category ID for store catalog',
    example: 'mix',
    required: false,
  })
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiProperty({
    description: 'Bundle/set selling price ("to\'plam narxi"). Optional.',
    example: '6000.00',
    required: false,
  })
  @IsString()
  @IsOptional()
  priceBundle?: string;

  @ApiProperty({
    description: 'Wholesale selling price ("ulgurji narxi"). Optional.',
    example: '5500.00',
    required: false,
  })
  @IsString()
  @IsOptional()
  priceWholesale?: string;

  @ApiProperty({
    description: 'Reorder point — flag "low stock" when quantity <= this.',
    example: 5,
    required: false,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  lowStockThreshold?: number;

  @ApiProperty({
    description: 'Brand ID this product belongs to',
    required: false,
  })
  @IsString()
  @IsOptional()
  brandId?: string;

  @ApiProperty({
    description: 'Default supplier ID this product is bought from',
    required: false,
  })
  @IsString()
  @IsOptional()
  supplierId?: string;

  @ApiProperty({
    description: 'Branch ("do\'kon") this product belongs to',
    required: false,
  })
  @IsString()
  @IsOptional()
  branchId?: string;
}

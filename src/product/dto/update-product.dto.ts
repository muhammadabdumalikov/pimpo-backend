import {ApiProperty} from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {PRODUCT_KINDS, type ProductKind} from '../../common/business-type';

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
    description:
      'Scale PLU — the short number pressed on a label-printing scale, which the scale embeds in the barcode it prints. Null on goods that are not weighed.',
    example: 1234,
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  plu?: number | null;

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

  @ApiProperty({
    description:
      "National classifier code (IKPU / MXIK, 17 digits) — required on every fiscal receipt line",
    example: '01905002004056061',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(17, {message: 'MXIK code must be at most 17 characters'})
  mxikCode?: string;

  @ApiProperty({
    description: 'Packaging/measure code that accompanies the MXIK code',
    example: '1',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(20, {message: 'Package code must be at most 20 characters'})
  packageCode?: string;

  @ApiProperty({
    description:
      "Card kind (FASTFOOD.md): 'stock' (default), 'dish' or 'semi'. Dish and " +
      'semi cards are for food businesses only and cannot change kind later.',
    enum: PRODUCT_KINDS,
    required: false,
  })
  @IsOptional()
  @IsIn(PRODUCT_KINDS)
  kind?: ProductKind;

  @ApiProperty({
    description:
      'Stock cards only: also show as a button on the fast-food till.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  showInMenu?: boolean;

  @ApiProperty({
    description:
      "Semi-finished cards only: how much one batch of the recipe makes, in the card's unit.",
    required: false,
  })
  @IsOptional()
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  recipeYield?: number;
}

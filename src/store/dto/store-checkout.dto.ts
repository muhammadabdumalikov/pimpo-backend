import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  Matches,
  MaxLength,
  Min,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';

export class StoreOrderItemDto {
  @ApiProperty({ description: 'Product id' })
  @IsString()
  productId: string;

  @ApiProperty({ description: 'Quantity', example: 1 })
  @IsInt()
  @Min(1)
  quantity: number;
}

export class StoreCheckoutDto {
  @ApiProperty({ description: 'Order items', type: [StoreOrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StoreOrderItemDto)
  items: StoreOrderItemDto[];

  @ApiProperty({ description: 'Customer name', required: false })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  customerName?: string;

  @ApiProperty({ description: 'Customer contact phone', example: '+998901234567' })
  @IsString()
  @Matches(/^\+?[\d\s()-]{9,20}$/, { message: 'phone must be a valid phone number' })
  phone: string;

  @ApiProperty({ description: 'Note', required: false })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

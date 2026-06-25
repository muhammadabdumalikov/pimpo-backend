import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  IsInt,
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
  @IsOptional()
  customerName?: string;

  @ApiProperty({ description: 'Customer phone', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Note', required: false })
  @IsString()
  @IsOptional()
  note?: string;
}

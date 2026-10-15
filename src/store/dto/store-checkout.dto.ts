import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsString,
  IsOptional,
  Max,
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

  @ApiProperty({
    description:
      'Telegram Mini App launch payload (window.Telegram.WebApp.initData). ' +
      'Verified against the bot token; when it checks out the order is bound ' +
      'to that Telegram user for history and status notifications. Ignored ' +
      'when absent or invalid — checkout still succeeds as a guest.',
    required: false,
  })
  @IsString()
  @MaxLength(4096)
  @IsOptional()
  initData?: string;

  @ApiProperty({
    description:
      "'pickup' | 'delivery'. Optional when the shop offers only one of them.",
    required: false,
    enum: ['pickup', 'delivery'],
  })
  @IsIn(['pickup', 'delivery'])
  @IsOptional()
  deliveryType?: 'pickup' | 'delivery';

  @ApiProperty({ description: 'Delivery address (required for delivery)', required: false })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  address?: string;

  @ApiProperty({ description: 'Shared location latitude', required: false })
  @IsNumber()
  @Min(-90)
  @Max(90)
  @IsOptional()
  lat?: number;

  @ApiProperty({ description: 'Shared location longitude', required: false })
  @IsNumber()
  @Min(-180)
  @Max(180)
  @IsOptional()
  lng?: number;

  @ApiProperty({
    description: 'Storefront locale; the language of status messages',
    required: false,
    enum: ['uz', 'uzc', 'ru', 'en'],
  })
  @IsIn(['uz', 'uzc', 'ru', 'en'])
  @IsOptional()
  locale?: 'uz' | 'uzc' | 'ru' | 'en';
}

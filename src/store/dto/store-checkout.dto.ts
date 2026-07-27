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
}

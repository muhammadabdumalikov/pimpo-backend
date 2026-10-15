import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {STAFF_CANCEL_REASONS} from '../online-order.rules';

export class DispatchOnlineOrderDto {
  @ApiPropertyOptional({
    description: 'Staff id of the courier (may hold no login); null = none',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  courierId?: string | null;
}

class TenderLineDto {
  @ApiProperty({description: "Payment-method code ('cash', 'card', custom-*)"})
  @IsString()
  @MaxLength(50)
  method: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  amount: number;
}

export class CompleteOnlineOrderDto {
  @ApiPropertyOptional({
    type: [TenderLineDto],
    description:
      'How the customer paid; omitted = all cash. Must add up to goods + delivery.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({each: true})
  @Type(() => TenderLineDto)
  payments?: TenderLineDto[];
}

export class CancelOnlineOrderDto {
  @ApiProperty({enum: STAFF_CANCEL_REASONS})
  @IsIn(STAFF_CANCEL_REASONS as unknown as string[])
  reason: (typeof STAFF_CANCEL_REASONS)[number];

  @ApiPropertyOptional({description: "Required when reason is 'other'"})
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

class ItemQtyDto {
  @ApiProperty()
  @IsString()
  itemId: string;

  @ApiProperty({description: 'New quantity — only lower; 0 removes the line'})
  @IsNumber()
  @Min(0)
  quantity: number;
}

export class UpdateOnlineOrderItemsDto {
  @ApiProperty({type: [ItemQtyDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => ItemQtyDto)
  items: ItemQtyDto[];
}

export class UpdateStoreDeliveryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pickupEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  deliveryEnabled?: boolean;

  @ApiPropertyOptional({description: "Fixed delivery fee, so'm"})
  @IsOptional()
  @IsNumber()
  @Min(0)
  deliveryFee?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Goods total from which delivery is free',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  freeDeliveryFrom?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Goods total below which delivery is not offered',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  minDeliveryAmount?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Branch online orders are served from; null = default',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  onlineBranchId?: string | null;
}

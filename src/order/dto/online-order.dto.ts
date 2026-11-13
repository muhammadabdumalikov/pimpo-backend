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
import {ORDER_CHANNELS, STAFF_CANCEL_REASONS} from '../online-order.rules';

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

  @ApiPropertyOptional({
    description:
      'Moliya account the money lands on; omitted = by method (cash → cash account, else non-cash)',
  })
  @IsOptional()
  @IsString()
  accountId?: string;
}

export class CompleteOnlineOrderDto {
  @ApiPropertyOptional({
    type: [TenderLineDto],
    description:
      'How the customer paid; omitted = all cash. Must add up to what is still due (goods + delivery − deposits).',
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

  @ApiPropertyOptional({
    enum: ['refund', 'keep'],
    description: 'What happens to a deposit: given back (default) or kept as income',
  })
  @IsOptional()
  @IsIn(['refund', 'keep'])
  deposit?: 'refund' | 'keep';
}

// ── Online seller (ONLAYN-SOTUVCHI.md §9.2) ─────────────────────────────

class LineOptionDto {
  @ApiProperty({example: "O'lcham"})
  @IsString()
  @MaxLength(40)
  name: string;

  @ApiProperty({example: '41'})
  @IsString()
  @MaxLength(40)
  value: string;
}

class ManualOrderItemDto {
  @ApiProperty()
  @IsString()
  productId: string;

  @ApiProperty()
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  quantity: number;

  @ApiPropertyOptional({type: [LineOptionDto]})
  @IsOptional()
  @IsArray()
  @ValidateNested({each: true})
  @Type(() => LineOptionDto)
  options?: LineOptionDto[];
}

export class DepositDto {
  @ApiProperty()
  @IsNumber({maxDecimalPlaces: 2})
  @Min(0.01)
  amount: number;

  @ApiProperty({description: "Payment-method code ('cash', 'card', custom-*)"})
  @IsString()
  @MaxLength(50)
  method: string;

  @ApiPropertyOptional({description: 'Moliya account; omitted = by method'})
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class CreateManualOnlineOrderDto {
  @ApiProperty({type: [ManualOrderItemDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => ManualOrderItemDto)
  items: ManualOrderItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerPhone?: string;

  @ApiProperty({enum: ['pickup', 'delivery']})
  @IsIn(['pickup', 'delivery'])
  deliveryType: 'pickup' | 'delivery';

  @ApiPropertyOptional({description: 'Required for delivery'})
  @IsOptional()
  @IsString()
  @MaxLength(500)
  deliveryAddress?: string;

  @ApiPropertyOptional({description: "Typed by hand, so'm"})
  @IsOptional()
  @IsNumber({maxDecimalPlaces: 2})
  @Min(0)
  deliveryFee?: number;

  @ApiPropertyOptional({enum: ORDER_CHANNELS})
  @IsOptional()
  @IsIn(ORDER_CHANNELS as unknown as string[])
  channel?: (typeof ORDER_CHANNELS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({type: DepositDto})
  @IsOptional()
  @ValidateNested()
  @Type(() => DepositDto)
  deposit?: DepositDto;
}

class ArrivalItemDto {
  @ApiProperty()
  @IsString()
  productId: string;

  @ApiProperty()
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  quantity: number;

  @ApiProperty({description: 'Unit cost in the arrival currency, before cargo'})
  @IsNumber()
  @Min(0)
  priceIn: number;
}

export class ArrivalDto {
  @ApiProperty({type: [ArrivalItemDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => ArrivalItemDto)
  items: ArrivalItemDto[];

  @ApiPropertyOptional({enum: ['UZS', 'USD'], default: 'UZS'})
  @IsOptional()
  @IsIn(['UZS', 'USD'])
  currency?: 'UZS' | 'USD';

  @ApiPropertyOptional({description: 'USD→UZS rate, required for USD'})
  @IsOptional()
  @IsNumber()
  @Min(0)
  usdRate?: number;

  @ApiPropertyOptional({description: 'Cargo, in the arrival currency'})
  @IsOptional()
  @IsNumber({maxDecimalPlaces: 2})
  @Min(0)
  extraCost?: number;

  @ApiPropertyOptional({description: 'Paid in full from this Moliya account'})
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowNegative?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
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

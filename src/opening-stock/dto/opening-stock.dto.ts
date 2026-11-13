import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';

export const OPENING_STOCK_SOURCES = ['undocumented', 'transfer'] as const;
export type OpeningStockSource = (typeof OPENING_STOCK_SOURCES)[number];

export class CreateOpeningStockDto {
  @ApiProperty({description: "Receiving branch (do'kon) id"})
  @IsString()
  @MaxLength(36)
  branchId: string;

  @ApiProperty({
    enum: OPENING_STOCK_SOURCES,
    description:
      "'undocumented' = goods with no paper (booked as capital); 'transfer' = goods brought from another branch",
  })
  @IsIn(OPENING_STOCK_SOURCES)
  source: OpeningStockSource;

  @ApiPropertyOptional({description: "Source branch, required for 'transfer'"})
  @ValidateIf((o: CreateOpeningStockDto) => o.source === 'transfer')
  @IsString()
  @MaxLength(36)
  fromBranchId?: string;

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class OpeningStockLineDto {
  @ApiProperty({description: 'Product id'})
  @IsString()
  @MaxLength(36)
  productId: string;

  @ApiProperty({
    description:
      'Absolute counted quantity for this line; 0 or less removes the line',
  })
  @IsNumber({maxDecimalPlaces: 3})
  quantity: number;

  @ApiPropertyOptional({
    description: "Cost per unit; null/absent = the card's priceIn",
    nullable: true,
  })
  @IsOptional()
  @IsNumber({maxDecimalPlaces: 2})
  @Min(0)
  unitCost?: number | null;
}

export class UpsertOpeningStockItemsDto {
  @ApiProperty({type: [OpeningStockLineDto]})
  @IsArray()
  @ValidateNested({each: true})
  @Type(() => OpeningStockLineDto)
  items: OpeningStockLineDto[];
}

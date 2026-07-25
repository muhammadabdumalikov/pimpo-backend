import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

// One accumulating-spend tier. Kept small and validated so a malformed tier
// list can't be persisted from the config page.
export class LoyaltyTierDto {
  @ApiPropertyOptional({ description: 'Tier display name, e.g. "Kumush"' })
  @IsString()
  @MaxLength(50)
  name!: string;

  @ApiPropertyOptional({ description: 'Lifetime spend (soʼm) to reach the tier' })
  @IsNumber()
  @Min(0)
  minTotal!: number;

  @ApiPropertyOptional({ description: 'Cashback rate (%) for this tier' })
  @IsNumber()
  @Min(0)
  @Max(100)
  cashbackPercent!: number;
}

export class UpdateLoyaltySettingsDto {
  @ApiPropertyOptional({ description: 'Master switch for the loyalty program' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Base cashback rate in percent', example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  cashbackPercent?: number;

  @ApiPropertyOptional({ description: 'Minimum sale total (soʼm) to earn cashback' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minPurchase?: number;

  @ApiPropertyOptional({
    description: 'Max share of one check payable from bonus balance (percent)',
    example: 50,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  redeemMaxPercent?: number;

  @ApiPropertyOptional({
    description: 'Bonus balance lifetime in months (null = never expires)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(120)
  expiryMonths?: number | null;

  @ApiPropertyOptional({
    description: 'Optional lifetime-spend tiers (empty = flat rate for all)',
    type: [LoyaltyTierDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyTierDto)
  tiers?: LoyaltyTierDto[];
}

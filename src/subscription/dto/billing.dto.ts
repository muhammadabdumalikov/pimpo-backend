import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DISCOUNT_KINDS, DISCOUNT_SCOPES } from '../../billing/billing';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Platform admin: set/update the legal details of a business's billing profile. */
export class UpdateBillingProfileDto {
  @ApiPropertyOptional({ description: 'Legal entity name, e.g. "WELL DOING GROUP" MChJ' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  legalName?: string;

  @ApiPropertyOptional({ description: 'INN / JShShIR' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  inn?: string;

  @ApiPropertyOptional({ description: 'Contract number, e.g. 2150/2024' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contractNumber?: string;

  @ApiPropertyOptional({ description: 'Contract date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  contractDate?: string;
}

/** Platform admin: credit a business's prepaid balance. */
export class TopUpBalanceDto {
  @ApiProperty({ description: 'Amount to add to the balance (UZS)', example: 500000 })
  @IsNumber({maxDecimalPlaces: 2})
  @IsPositive()
  @Max(10_000_000_000)
  amount: number;

  @ApiPropertyOptional({ description: 'Internal note for the ledger (never shown to the shop)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * A discount on the monthly bill, without its label — what the preview takes.
 * Which fields a kind needs (and the cross-field rules) are checked in
 * billing.ts normalizeDiscountInput; the decorators here only type the shape.
 */
export class DiscountTermsDto {
  @ApiPropertyOptional({
    description:
      "'percent' (default) — % off `scope`; 'amount' — so'm off the month; " +
      "'price' — so'm instead of the list price of the plan or of each extra branch",
    enum: DISCOUNT_KINDS,
  })
  @IsOptional()
  @IsIn(DISCOUNT_KINDS)
  kind?: string;

  @ApiPropertyOptional({
    description:
      "What a percent comes off ('plan' default, 'branches', 'all'), or which " +
      "price a 'price' replaces ('plan' | 'branches')",
    enum: DISCOUNT_SCOPES,
  })
  @IsOptional()
  @IsIn(DISCOUNT_SCOPES)
  scope?: string;

  @ApiPropertyOptional({ description: "Percent (1–100), for kind 'percent'", example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  percent?: number;

  @ApiPropertyOptional({
    description: "So'm, for kinds 'amount' and 'price'",
    example: 399000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  amount?: number;

  @ApiPropertyOptional({
    description:
      "Hold only while the shop is on this plan tier. A 'price' on the plan " +
      "defaults to the shop's current plan",
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  planTier?: string;

  @ApiPropertyOptional({ description: 'Discount expiry (ISO 8601); omit for open-ended' })
  @IsOptional()
  @IsDateString()
  validUntil?: string;
}

/** Platform admin: grant a discount on the monthly bill. */
export class CreateDiscountDto extends DiscountTermsDto {
  @ApiProperty({ description: 'Human label, e.g. "6 oyga 10% chegirma"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  label: string;
}

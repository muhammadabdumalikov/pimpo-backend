import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
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
  @IsNumber()
  @IsPositive()
  amount: number;
}

/** Platform admin: grant a promo discount on the monthly bill. */
export class CreateDiscountDto {
  @ApiProperty({ description: 'Human label, e.g. "6 oyga 10% chegirma"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  label: string;

  @ApiProperty({ description: 'Discount percent (1–100)', example: 10 })
  @IsInt()
  @Min(1)
  @Max(100)
  percent: number;

  @ApiPropertyOptional({ description: 'Discount expiry (ISO 8601); omit for open-ended' })
  @IsOptional()
  @IsDateString()
  validUntil?: string;
}

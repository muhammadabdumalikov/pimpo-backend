import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** "Ta'minotchiga to'lov" from Moliya: a shop account or Tashqi mablag'. */
export class PaySupplierFromAccountDto {
  @ApiPropertyOptional({
    description:
      'Finance account the money leaves (cash/bank); omitted when `external` is true',
  })
  @ValidateIf((o: PaySupplierFromAccountDto) => !o.external)
  @IsString()
  accountId?: string;

  @ApiPropertyOptional({
    description:
      "Paid from the owner's own pocket (Tashqi mablag') instead of a shop account",
  })
  @IsBoolean()
  @IsOptional()
  external?: boolean;

  @ApiProperty({
    description:
      'Amount (> 0). Settles the open receipts oldest first; the rest becomes the supplier advance.',
  })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({enum: ['UZS', 'USD'], default: 'UZS'})
  @IsString()
  @IsOptional()
  @IsIn(['UZS', 'USD'])
  currency?: 'UZS' | 'USD';

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description: 'Go ahead even if the account balance goes below zero',
  })
  @IsBoolean()
  @IsOptional()
  allowNegative?: boolean;
}

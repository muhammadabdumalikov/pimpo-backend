import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsIn,
  IsBoolean,
  Min,
  MaxLength,
  IsDateString,
  ValidateIf,
} from 'class-validator';

/** Shared body for income / expense (single-account) transactions. */
export class CreateTransactionDto {
  @ApiPropertyOptional({
    description: 'Account id (source); omitted when `external` is true',
  })
  @ValidateIf((o: CreateTransactionDto) => !o.external)
  @IsString()
  accountId?: string;

  @ApiProperty({description: 'Amount (> 0)'})
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({enum: ['UZS', 'USD'], default: 'UZS'})
  @IsString()
  @IsOptional()
  @IsIn(['UZS', 'USD'])
  currency?: 'UZS' | 'USD';

  @ApiPropertyOptional({description: 'Cash (naqd) or non-cash (naqdsiz)'})
  @IsBoolean()
  @IsOptional()
  isCash?: boolean;

  @ApiPropertyOptional({description: 'Finance category id'})
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({description: 'Operation date (ISO)'})
  @IsDateString()
  @IsOptional()
  operationDate?: string;

  @ApiPropertyOptional({
    description:
      "Expense only: paid from the owner's own pocket (Tashqi mablag') — books a capital kirim + this expense as a pair",
  })
  @IsBoolean()
  @IsOptional()
  external?: boolean;

  @ApiPropertyOptional({
    description: 'Go ahead even if the account balance goes below zero',
  })
  @IsBoolean()
  @IsOptional()
  allowNegative?: boolean;
}

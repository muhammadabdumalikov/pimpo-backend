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
} from 'class-validator';

/** Shared body for income / expense (single-account) transactions. */
export class CreateTransactionDto {
  @ApiProperty({description: 'Account id (source)'})
  @IsString()
  accountId: string;

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
}

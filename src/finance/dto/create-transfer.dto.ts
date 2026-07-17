import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsIn,
  Min,
  MaxLength,
  IsDateString,
} from 'class-validator';

/** Move money between two accounts in the same currency. */
export class CreateTransferDto {
  @ApiProperty({description: 'Source account id (from)'})
  @IsString()
  fromAccountId: string;

  @ApiProperty({description: 'Destination account id (to)'})
  @IsString()
  toAccountId: string;

  @ApiProperty({description: 'Amount (> 0)'})
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

  @ApiPropertyOptional({description: 'Operation date (ISO)'})
  @IsDateString()
  @IsOptional()
  operationDate?: string;
}

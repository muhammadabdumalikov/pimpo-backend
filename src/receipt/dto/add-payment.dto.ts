import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  Min,
  MaxLength,
  IsDateString,
} from 'class-validator';

/** Record a payment to the supplier against a goods receipt. */
export class AddPaymentDto {
  @ApiProperty({description: 'Finance account the money leaves (cash/bank)'})
  @IsString()
  accountId: string;

  @ApiProperty({description: 'Payment amount (> 0)'})
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({description: 'Payment date (ISO); defaults to now'})
  @IsDateString()
  @IsOptional()
  paidAt?: string;
}

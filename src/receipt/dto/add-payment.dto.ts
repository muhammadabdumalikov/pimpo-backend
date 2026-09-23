import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  Min,
  MaxLength,
  IsDateString,
  IsBoolean,
  ValidateIf,
} from 'class-validator';

/** Record a payment to the supplier against a goods receipt. */
export class AddPaymentDto {
  @ApiPropertyOptional({
    description:
      'Finance account the money leaves (cash/bank); omitted when `external` is true',
  })
  @ValidateIf((o: AddPaymentDto) => !o.external)
  @IsString()
  accountId?: string;

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

  @ApiPropertyOptional({
    description:
      "Paid from the owner's own pocket (Tashqi mablag') instead of a shop account",
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

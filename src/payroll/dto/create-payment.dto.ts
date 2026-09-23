import {ApiProperty} from '@nestjs/swagger';
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

export class CreatePaymentDto {
  @ApiProperty({description: 'Amount paid, UZS', example: 3000000})
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({
    description:
      'Finance account the money leaves from; omitted when `external` is true',
    required: false,
  })
  @ValidateIf((o: CreatePaymentDto) => !o.external)
  @IsString()
  accountId?: string;

  @ApiProperty({
    description: "'payment' settles wages owed; 'advance' is an avans",
    enum: ['payment', 'advance'],
    default: 'payment',
    required: false,
  })
  @IsIn(['payment', 'advance'])
  @IsOptional()
  type?: 'payment' | 'advance';

  @ApiProperty({description: 'Free-text note', required: false})
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;

  @ApiProperty({
    description:
      "Paid from the owner's own pocket (Tashqi mablag') instead of a shop account",
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  external?: boolean;

  @ApiProperty({
    description: 'Go ahead even if the account balance goes below zero',
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  allowNegative?: boolean;
}

import {ApiProperty} from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty({description: 'Amount paid, UZS', example: 3000000})
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({description: 'Finance account the money leaves from'})
  @IsString()
  accountId: string;

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
}

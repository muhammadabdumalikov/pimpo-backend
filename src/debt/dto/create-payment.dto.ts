import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsDecimal, IsIn } from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty({
    description: 'Payment amount (cannot exceed the debt\'s remaining balance)',
    example: '500.00',
  })
  @IsDecimal({ decimal_digits: '0,2' })
  @IsNotEmpty()
  amount: string;

  @ApiProperty({
    description: 'Payment method',
    example: 'cash',
    enum: ['cash', 'card'],
    required: false,
  })
  @IsString()
  @IsOptional()
  @IsIn(['cash', 'card'])
  method?: 'cash' | 'card';

  @ApiProperty({
    description: 'Optional note',
    example: 'First installment',
    required: false,
  })
  @IsString()
  @IsOptional()
  note?: string;
}

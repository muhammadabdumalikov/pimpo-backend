import { ApiProperty, PartialType } from '@nestjs/swagger';
import { CreateDebtDto } from './create-debt.dto';
import { IsString, IsOptional, IsDecimal, IsDateString, IsIn } from 'class-validator';

export class UpdateDebtDto extends PartialType(CreateDebtDto) {
  @ApiProperty({
    description: 'User name',
    example: 'John Doe',
    required: false,
  })
  @IsString()
  @IsOptional()
  userName?: string;

  @ApiProperty({
    description: 'User phone number',
    example: '+1 (555) 123-4567',
    required: false,
  })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({
    description: 'Debt amount',
    example: '1250.00',
    required: false,
  })
  @IsDecimal({ decimal_digits: '0,2' })
  @IsOptional()
  amount?: string;

  @ApiProperty({
    description: 'Debt status',
    example: 'Paid',
    enum: ['Paid', 'Pending', 'Overdue'],
    required: false,
  })
  @IsString()
  @IsOptional()
  @IsIn(['Paid', 'Pending', 'Overdue'])
  status?: string;

  @ApiProperty({
    description: 'Due date',
    example: '2028-01-15T00:00:00Z',
    required: false,
  })
  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @ApiProperty({
    description: 'Debt description',
    example: 'Monthly subscription payment',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsDecimal, IsDateString, IsIn, ValidateIf } from 'class-validator';

export class CreateDebtDto {
  @ApiProperty({
    description: 'User ID (if user already exists)',
    example: '01234567-89ab-cdef-0123-456789abcdef',
    required: false,
  })
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiProperty({
    description: 'User name (required if userId not provided)',
    example: 'John Doe',
    required: false,
  })
  @ValidateIf((o) => !o.userId)
  @IsString()
  @IsNotEmpty({ message: 'User name is required when userId is not provided' })
  userName?: string;

  @ApiProperty({
    description: 'User phone number (required if userId not provided)',
    example: '+1 (555) 123-4567',
    required: false,
  })
  @ValidateIf((o) => !o.userId)
  @IsString()
  @IsNotEmpty({ message: 'Phone is required when userId is not provided' })
  phone?: string;

  @ApiProperty({
    description: 'Debt amount',
    example: '1250.00',
  })
  @IsDecimal({ decimal_digits: '0,2' })
  @IsNotEmpty()
  amount: string;

  @ApiProperty({
    description: 'Debt status',
    example: 'Pending',
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
  })
  @IsDateString()
  @IsNotEmpty()
  dueDate: string;

  @ApiProperty({
    description: 'Debt description',
    example: 'Monthly subscription payment',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;
}

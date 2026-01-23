import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, IsBoolean } from 'class-validator';

export class UpdatePlanDto {
  @ApiProperty({
    description: 'Plan name',
    example: 'Basic Plan',
    required: false,
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'Plan description',
    example: 'Perfect for small businesses',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Plan price',
    example: '29.00',
    required: false,
  })
  @IsString()
  @IsOptional()
  price?: string;

  @ApiProperty({
    description: 'Debts limit (null for unlimited)',
    example: 20,
    required: false,
  })
  @IsNumber()
  @IsOptional()
  debtsLimit?: number | null;

  @ApiProperty({
    description: 'Products limit (null for unlimited)',
    example: 20,
    required: false,
  })
  @IsNumber()
  @IsOptional()
  productsLimit?: number | null;

  @ApiProperty({
    description: 'Is plan active',
    example: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

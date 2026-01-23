import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, IsBoolean, Min } from 'class-validator';

export class CreatePlanDto {
  @ApiProperty({
    description: 'Plan tier (free, basic, pro)',
    example: 'basic',
  })
  @IsString()
  tier: string;

  @ApiProperty({
    description: 'Plan name',
    example: 'Basic Plan',
  })
  @IsString()
  name: string;

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
  })
  @IsString()
  price: string;

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

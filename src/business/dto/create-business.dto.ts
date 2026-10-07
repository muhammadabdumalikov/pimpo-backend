import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsIn, IsOptional, MinLength } from 'class-validator';
import {BUSINESS_TYPES, type BusinessType} from '../../common/business-type';

export class CreateBusinessDto {
  @ApiProperty({
    description: 'Business name',
    example: 'Acme Corporation',
  })
  @IsString()
  name: string;

  @ApiProperty({
    description: 'Business email address',
    example: 'contact@acme.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Login username',
    example: 'acme_corp',
    minLength: 3,
  })
  @IsString()
  @MinLength(3)
  login: string;

  @ApiProperty({
    description: 'Password',
    example: 'securePassword123',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiPropertyOptional({
    description:
      "'retail' (default) or 'food' — a fast-food kitchen (FASTFOOD.md Q18). " +
      'A food business starts its trial on the kitchen plan.',
    enum: BUSINESS_TYPES,
  })
  @IsOptional()
  @IsIn(BUSINESS_TYPES)
  businessType?: BusinessType;
}

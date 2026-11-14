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
      "'retail' (default), 'food' — a fast-food kitchen (FASTFOOD.md Q18) — or " +
      "'online' — a seller with no shop or till (ONLAYN-SOTUVCHI.md §10). " +
      'Food and online businesses start their trial on their own plan.',
    enum: BUSINESS_TYPES,
  })
  @IsOptional()
  @IsIn(BUSINESS_TYPES)
  businessType?: BusinessType;
}

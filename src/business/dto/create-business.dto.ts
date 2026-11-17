import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsIn, IsOptional, Matches, MinLength } from 'class-validator';
import {BUSINESS_TYPES, type BusinessType} from '../../common/business-type';
import {PHONE_INPUT_RE} from '../../common/phone';

export class CreateBusinessDto {
  @ApiProperty({
    description: 'Business name',
    example: 'Acme Corporation',
  })
  @IsString()
  name: string;

  // Optional: the phone is the contact that matters at sign-up.
  @ApiPropertyOptional({
    description: 'Business email address',
    example: 'contact@acme.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  // The sign-up form requires it. Optional here only so a form that was loaded
  // before this field existed can still register.
  @ApiPropertyOptional({
    description: "Owner's contact phone (Uzbek number)",
    example: '+998901234567',
  })
  @IsOptional()
  @IsString()
  @Matches(PHONE_INPUT_RE, {message: 'phone must be a valid phone number'})
  phone?: string;

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

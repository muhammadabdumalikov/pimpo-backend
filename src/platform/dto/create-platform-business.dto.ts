import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsIn, IsOptional, Matches, MinLength, ValidateIf } from 'class-validator';
import { BUSINESS_TYPES, type BusinessType } from '../../common/business-type';
import { PHONE_INPUT_RE } from '../../common/phone';
import { UpdateBusinessDto } from '../../business/dto/update-business.dto';

/**
 * Platform admin: create a business. Email and phone are both optional — an
 * admin can register a shop that has neither on file.
 */
export class CreatePlatformBusinessDto {
  @ApiProperty({ description: 'Business name', example: 'Salom Market' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'Business email (optional)', example: 'salom@market.uz' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: "Owner's contact phone (optional)", example: '+998901234567' })
  @IsOptional()
  @IsString()
  @Matches(PHONE_INPUT_RE, { message: 'phone must be a valid phone number' })
  phone?: string;

  @ApiProperty({ description: 'Login username', example: 'salom_market', minLength: 3 })
  @IsString()
  @MinLength(3)
  login: string;

  @ApiProperty({ description: 'Password', example: 'securePass123', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiPropertyOptional({
    description: "'retail' (default), 'food' (FASTFOOD.md) or 'online' (ONLAYN-SOTUVCHI.md)",
    enum: BUSINESS_TYPES,
  })
  @IsOptional()
  @IsIn(BUSINESS_TYPES)
  businessType?: BusinessType;
}

/**
 * Platform admin: update a business. Only the platform may change its type —
 * the owner's own profile form cannot (FASTFOOD.md Q18).
 */
export class UpdatePlatformBusinessDto extends UpdateBusinessDto {
  @ApiPropertyOptional({
    description: "'retail', 'food' or 'online'. Switches defaults; never deletes data.",
    enum: BUSINESS_TYPES,
  })
  @IsOptional()
  @IsIn(BUSINESS_TYPES)
  businessType?: BusinessType;

  @ApiPropertyOptional({
    description: "Owner's contact phone; null or an empty string clears it",
    example: '+998901234567',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsString()
  @Matches(PHONE_INPUT_RE, { message: 'phone must be a valid phone number' })
  phone?: string | null;
}

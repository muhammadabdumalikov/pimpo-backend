import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsIn, IsOptional, MinLength } from 'class-validator';
import { BUSINESS_TYPES, type BusinessType } from '../../common/business-type';
import { UpdateBusinessDto } from '../../business/dto/update-business.dto';

/**
 * Platform admin: create a business. Unlike self-service signup
 * (CreateBusinessDto), email is OPTIONAL here — an admin can register a shop
 * that has no email on file.
 */
export class CreatePlatformBusinessDto {
  @ApiProperty({ description: 'Business name', example: 'Salom Market' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'Business email (optional)', example: 'salom@market.uz' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ description: 'Login username', example: 'salom_market', minLength: 3 })
  @IsString()
  @MinLength(3)
  login: string;

  @ApiProperty({ description: 'Password', example: 'securePass123', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiPropertyOptional({
    description: "'retail' (default) or 'food' — a fast-food kitchen (FASTFOOD.md)",
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
    description: "'retail' or 'food'. Switches defaults; never deletes data.",
    enum: BUSINESS_TYPES,
  })
  @IsOptional()
  @IsIn(BUSINESS_TYPES)
  businessType?: BusinessType;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, MinLength } from 'class-validator';

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
}

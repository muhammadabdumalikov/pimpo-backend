import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsBoolean, MinLength } from 'class-validator';

export class UpdateBusinessDto {
  @ApiPropertyOptional({
    description: 'Business name',
    example: 'Acme Corporation Updated',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Business email address',
    example: 'newemail@acme.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'Login username',
    example: 'acme_corp_new',
    minLength: 3,
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  login?: string;

  @ApiPropertyOptional({
    description: 'Password',
    example: 'newSecurePassword123',
    minLength: 6,
  })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @ApiPropertyOptional({
    description: 'Business account active status',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

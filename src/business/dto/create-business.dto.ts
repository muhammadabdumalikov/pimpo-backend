import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, MinLength } from 'class-validator';

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
}

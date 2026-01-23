import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'Login username',
    example: 'acme_corp',
  })
  @IsString()
  login: string;

  @ApiProperty({
    description: 'Password',
    example: 'securePassword123',
  })
  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password: string;
}

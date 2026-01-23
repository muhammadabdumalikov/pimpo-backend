import { ApiProperty } from '@nestjs/swagger';
import { BusinessResponseDto } from './business-response.dto';

export class LoginResponseDto {
  @ApiProperty({
    description: 'JWT access token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Token type',
    example: 'Bearer',
  })
  tokenType: string;

  @ApiProperty({
    description: 'Token expiration time',
    example: '7d',
  })
  expiresIn: string;

  @ApiProperty({
    description: 'Business information',
    type: BusinessResponseDto,
  })
  business: BusinessResponseDto;
}

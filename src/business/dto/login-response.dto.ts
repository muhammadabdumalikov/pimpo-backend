import { ApiProperty } from '@nestjs/swagger';
import { BusinessResponseDto } from './business-response.dto';

export class AccountDto {
  @ApiProperty({ description: 'Account type', enum: ['business', 'staff'] })
  type: 'business' | 'staff';

  @ApiProperty({ description: 'Account id (business id or staff id)' })
  id: string;

  @ApiProperty({ description: 'Display name' })
  name: string;

  @ApiProperty({ description: 'Login username' })
  login: string;

  @ApiProperty({ description: 'Assigned role id (staff only)', nullable: true })
  roleId: string | null;

  @ApiProperty({ description: 'Assigned role name (staff only)', nullable: true })
  roleName: string | null;

  @ApiProperty({
    description: 'Allowed sidebar menu keys. ["*"] means full access (owner).',
    example: ['ecommerce.products', 'userDebt'],
    type: [String],
  })
  menuKeys: string[];
}

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

  @ApiProperty({
    description: 'Acting account (owner or staff) with allowed menu keys',
    type: AccountDto,
  })
  account: AccountDto;
}

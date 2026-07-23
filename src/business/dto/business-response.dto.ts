import { ApiProperty } from '@nestjs/swagger';

export class BusinessResponseDto {
  @ApiProperty({
    description: 'Business unique identifier',
    example: '018f1234-5678-9abc-def0-123456789abc',
  })
  id: string;

  @ApiProperty({
    description: 'Business name',
    example: 'Acme Corporation',
  })
  name: string;

  @ApiProperty({
    description: 'Business email address',
    example: 'contact@acme.com',
  })
  email: string;

  @ApiProperty({
    description: 'Login username',
    example: 'acme_corp',
  })
  login: string;

  @ApiProperty({
    description: 'Business account active status',
    example: true,
  })
  isActive: boolean;

  @ApiProperty({
    description: 'Online-store subdomain slug (null until set)',
    example: 'salom-market',
    nullable: true,
    required: false,
  })
  storeSlug?: string | null;

  @ApiProperty({
    description: 'Whether the online storefront is publicly reachable',
    example: false,
    required: false,
  })
  storeEnabled?: boolean;

  @ApiProperty({
    description: 'Account creation timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  updatedAt: Date;
}

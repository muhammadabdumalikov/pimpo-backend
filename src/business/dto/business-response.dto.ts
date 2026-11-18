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
    description: 'One line shown under the name on the online store',
    example: "Ayollar kiyimi — Toshkent bo'ylab yetkazib beramiz",
    nullable: true,
    required: false,
  })
  storeTagline?: string | null;

  @ApiProperty({
    description: 'Instagram username of the store (bare, no "@")',
    example: 'zarastyle',
    nullable: true,
    required: false,
  })
  storeInstagram?: string | null;

  @ApiProperty({
    description: 'Telegram username of the store (bare, no "@")',
    example: 'zarastyle',
    nullable: true,
    required: false,
  })
  storeTelegram?: string | null;

  @ApiProperty({
    description: 'Public contact phone of the store ("+998" and nine digits)',
    example: '+998901234567',
    nullable: true,
    required: false,
  })
  storePhone?: string | null;

  @ApiProperty({
    description: 'Store logo URL (square WebP)',
    nullable: true,
    required: false,
  })
  storeLogo?: string | null;

  @ApiProperty({
    description: 'Store cover picture URL (3:1 WebP)',
    nullable: true,
    required: false,
  })
  storeCover?: string | null;

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

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Owner-facing settings for the online storefront: subdomain + on/off, and its
 * branding. Every field is optional — an omitted one is left as it is; for the
 * text and picture fields null or an empty string clears it.
 */
export class UpdateStoreSettingsDto {
  @ApiPropertyOptional({
    description:
      'Storefront subdomain slug (a-z, 0-9, hyphen; 3-63 chars). null clears it.',
    example: 'salom-market',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  storeSlug?: string | null;

  @ApiPropertyOptional({
    description: 'Whether the storefront is publicly reachable',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  storeEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'One line shown under the shop name (trimmed; line breaks become spaces; max 140 chars). null or "" clears it.',
    example: "Ayollar kiyimi — Toshkent bo'ylab yetkazib beramiz",
    nullable: true,
    maxLength: 140,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(400)
  storeTagline?: string | null;

  @ApiPropertyOptional({
    description:
      'Instagram account: "name", "@name" or a pasted profile link (instagram.com/name, …?igsh=…). Stored as the bare lowercase username. null or "" clears it.',
    example: 'https://instagram.com/zarastyle/',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  storeInstagram?: string | null;

  @ApiPropertyOptional({
    description:
      'Telegram account: "name", "@name" or a pasted link (t.me/name). Stored as the bare username. null or "" clears it.',
    example: '@zarastyle',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  storeTelegram?: string | null;

  @ApiPropertyOptional({
    description:
      'Public contact phone, an Uzbek number in any usual spelling; stored as "+998" and nine digits. null or "" clears it.',
    example: '90 123 45 67',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(32)
  storePhone?: string | null;

  @ApiPropertyOptional({
    description:
      'URL returned by POST /businesses/me/store/logo. null or "" removes the logo.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  storeLogo?: string | null;

  @ApiPropertyOptional({
    description:
      'URL returned by POST /businesses/me/store/cover. null or "" removes the cover.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  storeCover?: string | null;
}

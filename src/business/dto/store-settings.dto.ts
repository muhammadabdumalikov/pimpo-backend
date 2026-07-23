import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, ValidateIf } from 'class-validator';

/** Owner-facing settings for the online storefront (subdomain + on/off). */
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
}

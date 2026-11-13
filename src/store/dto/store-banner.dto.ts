import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export const BANNER_LINK_TYPES = [
  'none',
  'product',
  'category',
  'url',
] as const;
export type BannerLinkType = (typeof BANNER_LINK_TYPES)[number];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Create, and — every field optional — update. Text fields take an empty
 * string or null to clear; dates take null for "no bound".
 */
export class SaveStoreBannerDto {
  @ApiPropertyOptional({description: 'URL returned by the banner image upload'})
  @IsOptional()
  @IsString()
  @MaxLength(500)
  image?: string;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  title?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(140)
  subtitle?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(30)
  buttonLabel?: string | null;

  @ApiPropertyOptional({enum: BANNER_LINK_TYPES})
  @IsOptional()
  @IsIn(BANNER_LINK_TYPES)
  linkType?: BannerLinkType;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Product id, category id or http(s) address',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  linkValue?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'First day shown, YYYY-MM-DD',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(YMD)
  startsOn?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Last day shown, YYYY-MM-DD',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(YMD)
  endsOn?: string | null;
}

export class ReorderStoreBannersDto {
  @ApiProperty({
    type: [String],
    description: 'Every banner id, in the new order',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({each: true})
  ids!: string[];
}

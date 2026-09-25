import {ApiProperty, ApiPropertyOptional, PartialType} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_KINDS,
  type AnnouncementAudience,
  type AnnouncementKind,
} from '../announcement.constants';
import {TIER_RANK, type Tier} from '../../subscription/tier';

const TIERS = Object.keys(TIER_RANK) as Tier[];

export class AnnouncementTitleDto {
  @ApiProperty({example: 'Yaroqsiz tovarlar ombori'})
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  uz: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  ru?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  en?: string;
}

export class AnnouncementBodyDto {
  @ApiProperty({description: 'Plain text; line breaks are kept'})
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  uz: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  ru?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  en?: string;
}

/**
 * On update every field is optional; `null` clears a nullable one (linkUrl,
 * minTier, featureKey, publishedAt, expiresAt), `undefined` leaves it alone.
 */
export class CreateAnnouncementDto {
  @ApiPropertyOptional({enum: ANNOUNCEMENT_KINDS, default: 'feature'})
  @IsOptional()
  @IsIn(ANNOUNCEMENT_KINDS)
  kind?: AnnouncementKind;

  @ApiProperty({type: AnnouncementTitleDto})
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => AnnouncementTitleDto)
  title: AnnouncementTitleDto;

  @ApiProperty({type: AnnouncementBodyDto})
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => AnnouncementBodyDto)
  body: AnnouncementBodyDto;

  @ApiPropertyOptional({
    description:
      'In-app path ("/reports/losses") or an https:// URL for the button',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  // An in-app path (but not protocol-relative "//host") or https — never
  // javascript:, data: or plain http.
  @Matches(/^(\/(?!\/)|https:\/\/)\S*$/)
  linkUrl?: string | null;

  @ApiProperty({enum: ANNOUNCEMENT_AUDIENCES})
  @IsIn(ANNOUNCEMENT_AUDIENCES)
  audience: AnnouncementAudience;

  @ApiPropertyOptional({
    enum: TIERS,
    nullable: true,
    description: "Required when audience = 'tier'",
  })
  @IsOptional()
  @IsIn(TIERS)
  minTier?: Tier | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "Required when audience = 'feature'",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  featureKey?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      "Business IDs when audience = 'selected'. On update, replaces the list.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsString({each: true})
  businessIds?: string[];

  @ApiPropertyOptional({
    default: false,
    description: 'Open as a modal on next app load',
  })
  @IsOptional()
  @IsBoolean()
  popup?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO 8601. Null/omitted = draft; a future time schedules it',
  })
  @IsOptional()
  @IsDateString()
  publishedAt?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO 8601. Null/omitted = never expires',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}

export class UpdateAnnouncementDto extends PartialType(CreateAnnouncementDto) {}

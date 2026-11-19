import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PushKeysDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  p256dh!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  auth!: string;
}

/** A browser PushSubscription (its toJSON()) + the language for the texts. */
export class SubscribePushDto {
  @ApiProperty()
  @IsUrl({require_tld: false, protocols: ['https']})
  @MaxLength(2000)
  endpoint!: string;

  @ApiProperty({type: PushKeysDto})
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  // Browsers add expirationTime to toJSON(); accepted and ignored.
  @ApiPropertyOptional()
  @IsOptional()
  expirationTime?: number | null;

  @ApiPropertyOptional({enum: ['uz', 'ru', 'uzc', 'en']})
  @IsIn(['uz', 'ru', 'uzc', 'en'])
  @IsOptional()
  locale?: string;
}

// An APNs device token as the iPhone app sends it: the raw bytes in hex
// (32 bytes today; Apple says the length may change).
const APNS_TOKEN = /^[0-9a-fA-F]{32,200}$/;

/** The iPhone app's APNs device token (kpos-ios), relayed by the web app. */
export class RegisterApnsDto {
  @ApiProperty()
  @Matches(APNS_TOKEN)
  token!: string;

  @ApiProperty({enum: ['sandbox', 'production']})
  @IsIn(['sandbox', 'production'])
  environment!: 'sandbox' | 'production';

  @ApiPropertyOptional({enum: ['uz', 'ru', 'uzc', 'en']})
  @IsIn(['uz', 'ru', 'uzc', 'en'])
  @IsOptional()
  locale?: string;
}

export class UnregisterApnsDto {
  @ApiProperty()
  @Matches(APNS_TOKEN)
  token!: string;
}

export class UnsubscribePushDto {
  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  endpoint!: string;
}

export class NotificationListQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({default: 30})
  @IsNumberString()
  @IsOptional()
  limit?: string;
}

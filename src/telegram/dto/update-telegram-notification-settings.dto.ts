import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsBoolean, IsOptional, Matches} from 'class-validator';
import {HM_PATTERN} from '../../digest/digest-schedule';

/**
 * Body for PUT /telegram/notification-settings. Every flag is optional — only
 * the provided ones are updated (partial patch of the per-business toggles).
 */
export class UpdateTelegramNotificationSettingsDto {
  @ApiPropertyOptional({description: 'Notify on every completed sale (checkout)'})
  @IsOptional()
  @IsBoolean()
  checkout?: boolean;

  @ApiPropertyOptional({description: 'Notify on cash shift open / close'})
  @IsOptional()
  @IsBoolean()
  cashShifts?: boolean;

  @ApiPropertyOptional({description: 'Notify on manual cash in / out movements'})
  @IsOptional()
  @IsBoolean()
  cashOperations?: boolean;

  @ApiPropertyOptional({description: 'Send the daily sales digest (at dailySalesSendAt)'})
  @IsOptional()
  @IsBoolean()
  dailySales?: boolean;

  @ApiPropertyOptional({description: 'A storefront (online) order arrived'})
  @IsOptional()
  @IsBoolean()
  onlineOrders?: boolean;

  @ApiPropertyOptional({
    description: 'Staff cancelled a receipt, gave a discount over 20 %, or took a return',
  })
  @IsOptional()
  @IsBoolean()
  suspicious?: boolean;

  @ApiPropertyOptional({description: '09:00 digest of out-of-stock / low products'})
  @IsOptional()
  @IsBoolean()
  lowStock?: boolean;

  @ApiPropertyOptional({description: 'Platform announcements as a phone push'})
  @IsOptional()
  @IsBoolean()
  announcements?: boolean;

  @ApiPropertyOptional({
    description:
      "A delivery's lower price that waited for the older stock took effect — reprint the shelf label",
  })
  @IsOptional()
  @IsBoolean()
  priceChanges?: boolean;

  @ApiPropertyOptional({
    description: "When the daily digest is sent, business-zone 'HH:MM'",
    example: '21:00',
  })
  @IsOptional()
  @Matches(HM_PATTERN, {message: 'dailySalesSendAt must be HH:MM'})
  dailySalesSendAt?: string;

  @ApiPropertyOptional({
    description:
      "Start of the hours the digest covers, 'HH:MM'. From ≥ to crosses midnight; from = to is 24 h.",
    example: '09:00',
  })
  @IsOptional()
  @Matches(HM_PATTERN, {message: 'dailySalesFrom must be HH:MM'})
  dailySalesFrom?: string;

  @ApiPropertyOptional({description: "End of the hours the digest covers, 'HH:MM' (exclusive)", example: '21:00'})
  @IsOptional()
  @Matches(HM_PATTERN, {message: 'dailySalesTo must be HH:MM'})
  dailySalesTo?: string;
}

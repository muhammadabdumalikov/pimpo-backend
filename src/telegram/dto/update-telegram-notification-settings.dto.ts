import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsBoolean, IsOptional} from 'class-validator';

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

  @ApiPropertyOptional({description: 'Send the daily sales digest (21:00)'})
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
}

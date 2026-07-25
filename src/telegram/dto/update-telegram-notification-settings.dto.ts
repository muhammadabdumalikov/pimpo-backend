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
}

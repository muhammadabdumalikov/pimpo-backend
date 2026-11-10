import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsDateString } from 'class-validator';

/**
 * Platform admin: set a specific business's subscription plan (and, optionally,
 * its expiry). A fresh active subscription row is created on the chosen tier.
 */
export class SetSubscriptionDto {
  @ApiProperty({
    description: 'Subscription tier to place the business on',
    enum: ['free', 'basic', 'pro', 'proplus', 'food'],
    example: 'pro',
  })
  @IsEnum(['free', 'basic', 'pro', 'proplus', 'food'])
  tier: 'free' | 'basic' | 'pro' | 'proplus' | 'food';

  @ApiPropertyOptional({
    description:
      'Subscription end/expiry date (ISO 8601). Omit to make the subscription open-ended (unlimited).',
    example: '2026-12-31T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description:
      'Mark the period as a trial: plan changes are free and reminders read "continue". Defaults to false.',
  })
  @IsOptional()
  @IsBoolean()
  isTrial?: boolean;
}

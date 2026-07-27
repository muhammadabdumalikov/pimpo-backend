import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsOptional, IsString, MaxLength, ValidateIf} from 'class-validator';

/** Connect (or disconnect) the shop's own customer-facing Telegram bot. */
export class UpdateStoreBotDto {
  @ApiPropertyOptional({
    description:
      'Bot token from BotFather (e.g. "123456789:AA..."). Verified with getMe ' +
      'before it is saved. null or an empty string disconnects the bot, after ' +
      'which the storefront falls back to the platform bot.',
    example: '123456789:AAExampleTokenFromBotFather',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  botToken?: string | null;
}

import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  AI_PROVIDER_IDS,
  AiProviderId,
} from '../providers/llm-provider.interface';

export class SaveAiSettingsDto {
  @ApiProperty({enum: AI_PROVIDER_IDS})
  @IsIn(AI_PROVIDER_IDS as unknown as string[])
  provider!: AiProviderId;

  @ApiProperty({example: 'claude-opus-5'})
  @IsString()
  @MaxLength(60)
  model!: string;

  /**
   * Raw provider key. Omit to keep the stored one (so the owner can switch
   * model or toggle `enabled` without re-typing their key).
   */
  @ApiPropertyOptional({description: 'Omit to keep the existing key'})
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(400)
  apiKey?: string;

  @ApiPropertyOptional({default: true})
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

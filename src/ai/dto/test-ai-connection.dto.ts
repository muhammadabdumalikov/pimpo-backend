import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
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

export class TestAiConnectionDto {
  @ApiProperty({enum: AI_PROVIDER_IDS})
  @IsIn(AI_PROVIDER_IDS as unknown as string[])
  provider!: AiProviderId;

  /** Required by /test; ignored by /models, which only needs provider + key. */
  @ApiPropertyOptional({example: 'claude-opus-5'})
  @IsOptional()
  @IsString()
  @MaxLength(60)
  model?: string;

  /** Omit to test the key already stored for this business. */
  @ApiPropertyOptional({description: 'Omit to test the stored key'})
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(400)
  apiKey?: string;
}

import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class AiTurnDto {
  @ApiProperty({enum: ['user', 'assistant']})
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  content!: string;
}

export class AskAiDto {
  @ApiProperty({example: "Bu oy sotuvlarim qancha bo'ldi?"})
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  question!: string;

  /**
   * Prior turns, oldest first. The client owns conversation state — the server
   * stores no transcript, which keeps shop data out of our storage entirely.
   */
  @ApiPropertyOptional({type: [AiTurnDto]})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({each: true})
  @Type(() => AiTurnDto)
  history?: AiTurnDto[];

  @ApiPropertyOptional({enum: ['uz', 'ru', 'en'], default: 'uz'})
  @IsOptional()
  @IsIn(['uz', 'ru', 'en'])
  locale?: 'uz' | 'ru' | 'en';

  /**
   * Use a different model than the saved default for this question only.
   * The provider is fixed (it owns the key) — only the model varies.
   */
  @ApiPropertyOptional({example: 'claude-sonnet-5'})
  @IsOptional()
  @IsString()
  @MaxLength(60)
  model?: string;
}

import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UpdateAssistantSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({enum: ['formal', 'friendly']})
  @IsOptional()
  @IsIn(['formal', 'friendly'])
  tone?: 'formal' | 'friendly';

  @ApiPropertyOptional({description: '/start message; null = built-in'})
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  greeting?: string | null;

  @ApiPropertyOptional({description: 'Returns, warranty, credit, …'})
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  policies?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  shareWithPlatform?: boolean;
}

export class CreateFaqDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  question: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  answer: string;
}

export class UpdateFaqDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  question?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  answer?: string;
}

export class TestTurnDto {
  @ApiProperty({enum: ['user', 'assistant']})
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  content: string;
}

export class TestAssistantDto {
  @ApiPropertyOptional({type: [TestTurnDto]})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({each: true})
  @Type(() => TestTurnDto)
  history?: TestTurnDto[];

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question: string;
}

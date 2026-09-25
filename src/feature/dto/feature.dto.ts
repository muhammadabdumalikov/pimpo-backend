import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import {ROLLOUTS, type Rollout} from '../feature.resolve';

export class SetRolloutDto {
  @ApiProperty({
    enum: ROLLOUTS,
    description:
      "'off' = nobody (kill switch), 'selected' = only the shops on the list, 'all' = everyone except excluded shops",
  })
  @IsIn(ROLLOUTS)
  rollout: Rollout;
}

export class SetFeatureOverridesDto {
  @ApiProperty({type: [String], description: 'Business IDs'})
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({each: true})
  businessIds: string[];

  @ApiPropertyOptional({
    description:
      'true = put on the beta list, false = exclude from an "all" rollout',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SetBusinessFeatureDto {
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      "true / false = this shop's exception; null = follow the rollout",
  })
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  enabled: boolean | null;
}

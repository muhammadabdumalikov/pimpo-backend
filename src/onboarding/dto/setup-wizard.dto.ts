import {ApiPropertyOptional} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {MAX_DIRECTIONS, SETUP_STATUSES, SETUP_WIZARD_STEPS} from '../onboarding.wizard';

/** POST /onboarding/wizard — every field optional; an omitted one is left as is. */
export class SaveSetupWizardDto {
  @ApiPropertyOptional({enum: SETUP_WIZARD_STEPS, description: 'Last step reached'})
  @IsOptional()
  @IsIn(SETUP_WIZARD_STEPS)
  step?: string;

  @ApiPropertyOptional({enum: SETUP_STATUSES, description: "'done' = finished, 'skipped' = Keyinroq"})
  @IsOptional()
  @IsIn(SETUP_STATUSES)
  status?: string;

  @ApiPropertyOptional({type: [String], description: `store_directions keys, at most ${MAX_DIRECTIONS}`})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DIRECTIONS)
  @IsString({each: true})
  @MaxLength(64, {each: true})
  directions?: string[];

  @ApiPropertyOptional({description: 'What the owner typed instead of picking; "" clears it'})
  @IsOptional()
  @IsString()
  @MaxLength(200)
  directionText?: string;
}

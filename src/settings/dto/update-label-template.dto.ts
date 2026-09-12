import {ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {Transform} from 'class-transformer';
import {UpdateLabelSettingsDto} from './update-label-settings.dto';

/**
 * Edit one label template. Every field is optional: the settings page saves the
 * whole form, but renaming or promoting a template sends one field on its own.
 *
 * `isDefault: false` is ignored — a business always prints with something, so
 * the default moves by promoting another template, never by clearing this one.
 */
export class UpdateLabelTemplateDto extends UpdateLabelSettingsDto {
  @ApiPropertyOptional({description: 'What the shop calls this template'})
  @IsOptional()
  @IsString()
  @Transform(({value}: {value: unknown}) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({description: 'Make this the default template'})
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({description: 'Display order in the list (0-999)'})
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

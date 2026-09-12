import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
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
 * A new label template. Only the name is required — a shop adding "Kichik"
 * starts from the house defaults and edits the size afterwards, on the page
 * where it can see the result.
 *
 * The layout fields and their millimetre bounds come from
 * {@link UpdateLabelSettingsDto}: a template IS a label layout, and the two
 * must not be able to drift apart on what counts as printable stock.
 */
export class CreateLabelTemplateDto extends UpdateLabelSettingsDto {
  @ApiProperty({description: 'What the shop calls this template'})
  @IsString()
  @Transform(({value}: {value: unknown}) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

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

import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** POST /categories/presets/apply — add ready-made and own categories. */
export class ApplyCategoryPresetDto {
  @ApiPropertyOptional({type: [String], example: ['dairy', 'drinks']})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({each: true})
  @MaxLength(64, {each: true})
  globalKeys?: string[];

  @ApiPropertyOptional({type: [String], example: ['Tormoz qismlari']})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({each: true})
  @MaxLength(255, {each: true})
  customNames?: string[];
}

/** POST /categories/presets/suggest — what the shop sells, in the owner's words. */
export class SuggestCategoriesDto {
  @ApiProperty({example: "avto ehtiyot qismlar va moy"})
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  text: string;
}

/** Platform console: create (key required) or change a global category. */
export class SaveGlobalCategoryDto {
  @ApiPropertyOptional({example: 'drinks'})
  @IsOptional()
  @IsString()
  @MaxLength(64)
  key?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameUz?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameUzc?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameRu?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameEn?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isHidden?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() sort?: number;
}

/** Platform console: create (key required) or change a line of trade. */
export class SaveStoreDirectionDto extends SaveGlobalCategoryDto {
  @ApiPropertyOptional({type: [String], example: ['dairy', 'bread']})
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({each: true})
  @MaxLength(64, {each: true})
  categoryKeys?: string[];
}

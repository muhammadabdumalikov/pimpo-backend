import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
} from 'class-validator';
import {IMPORT_ENTITIES, type ImportEntity} from '../billz-import.types';

export class StartImportDto {
  @ApiProperty({
    description:
      'Non-empty subset of the importable entities to migrate from BiLLZ.',
    enum: IMPORT_ENTITIES as unknown as string[],
    isArray: true,
    example: ['products', 'customers'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(IMPORT_ENTITIES as unknown as string[], {each: true})
  entities: ImportEntity[];

  @ApiPropertyOptional({
    description:
      'Import products together with their BiLLZ categories (create + link). ' +
      'false imports the products alone, leaving categories untouched. Default true.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  withCategories?: boolean;
}

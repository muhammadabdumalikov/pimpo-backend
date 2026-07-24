import {ApiProperty} from '@nestjs/swagger';
import {ArrayNotEmpty, ArrayUnique, IsArray, IsIn} from 'class-validator';
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
}

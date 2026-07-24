import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsIn, IsOptional, IsString} from 'class-validator';
import {IMPORT_ENTITIES, type ImportEntity} from '../billz-import.types';

// page/limit stay strings and are parsed in the service (matches the repo's
// query-DTO convention, e.g. finance QueryTransactionsDto).
export class ImportItemsQueryDto {
  @ApiProperty({
    description: 'Which entity log to browse.',
    enum: IMPORT_ENTITIES as unknown as string[],
  })
  @IsString()
  @IsIn(IMPORT_ENTITIES as unknown as string[])
  entity: ImportEntity;

  @ApiPropertyOptional({
    description: 'Filter by outcome.',
    enum: ['success', 'failed', 'all'],
    default: 'all',
  })
  @IsOptional()
  @IsString()
  @IsIn(['success', 'failed', 'all'])
  status?: 'success' | 'failed' | 'all';

  @ApiPropertyOptional({description: 'Page (1-based).', default: 1})
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({description: 'Page size (max 100).', default: 50})
  @IsOptional()
  @IsString()
  limit?: string;
}

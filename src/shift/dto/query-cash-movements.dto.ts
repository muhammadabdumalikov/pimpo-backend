import {ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Kassa operatsiyalari: cash movements across shifts, filtered. */
export class QueryCashMovementsDto {
  @ApiPropertyOptional({
    description: 'From business day (YYYY-MM-DD, inclusive)',
  })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({description: 'To business day (YYYY-MM-DD, inclusive)'})
  @IsDateString()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({description: 'One shift only (e.g. the open one)'})
  @IsString()
  @IsOptional()
  shiftId?: string;

  @ApiPropertyOptional({description: 'One register only'})
  @IsString()
  @IsOptional()
  registerId?: string;

  @ApiPropertyOptional({enum: ['in', 'out']})
  @IsIn(['in', 'out'])
  @IsOptional()
  type?: 'in' | 'out';

  @ApiPropertyOptional({enum: ['cash', 'cashless']})
  @IsIn(['cash', 'cashless'])
  @IsOptional()
  method?: 'cash' | 'cashless';

  @ApiPropertyOptional({enum: ['UZS', 'USD']})
  @IsIn(['UZS', 'USD'])
  @IsOptional()
  currency?: 'UZS' | 'USD';

  @ApiPropertyOptional({
    description:
      "A cash category id, or 'supplier' (Ta'minotchiga to'lov) or 'none' (no category)",
  })
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({description: 'Supplier paid from the till'})
  @IsString()
  @IsOptional()
  supplierId?: string;

  @ApiPropertyOptional({description: 'Who recorded it (staff id or owner id)'})
  @IsString()
  @IsOptional()
  cashierId?: string;

  @ApiPropertyOptional({
    description: 'Text in the note, category, supplier or cashier name',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({description: 'Page (1-based)', default: 1})
  @IsOptional()
  page?: string;

  @ApiPropertyOptional({description: 'Page size (max 500)', default: 50})
  @IsOptional()
  limit?: string;
}

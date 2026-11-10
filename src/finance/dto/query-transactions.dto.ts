import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, IsIn, IsDateString} from 'class-validator';

export class QueryTransactionsDto {
  @ApiPropertyOptional({
    enum: ['income', 'expense', 'transfer', 'conversion', 'shift_close'],
  })
  @IsString()
  @IsOptional()
  @IsIn(['income', 'expense', 'transfer', 'conversion', 'shift_close'])
  kind?: 'income' | 'expense' | 'transfer' | 'conversion' | 'shift_close';

  @ApiPropertyOptional({description: 'Filter by account id'})
  @IsString()
  @IsOptional()
  accountId?: string;

  @ApiPropertyOptional({description: 'Filter by category id'})
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({description: 'From date (ISO, inclusive)'})
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({description: 'To date (ISO, inclusive)'})
  @IsDateString()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({
    description:
      "'true' keeps only what the profit report counts: no money to or from suppliers, no capital rows, no storno rows",
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  operating?: 'true' | 'false';

  @ApiPropertyOptional({description: 'Page (1-based)', default: 1})
  @IsOptional()
  page?: string;

  @ApiPropertyOptional({description: 'Page size', default: 50})
  @IsOptional()
  limit?: string;
}

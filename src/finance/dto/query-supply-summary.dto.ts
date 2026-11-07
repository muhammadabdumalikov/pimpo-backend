import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsOptional, IsDateString} from 'class-validator';

export class QuerySupplySummaryDto {
  @ApiPropertyOptional({description: 'From date (ISO, inclusive)'})
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({description: 'To date (ISO, inclusive)'})
  @IsDateString()
  @IsOptional()
  to?: string;
}

import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, MaxLength} from 'class-validator';

export class CompleteStockTakeDto {
  @ApiPropertyOptional({description: 'Optional note recorded on completion'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

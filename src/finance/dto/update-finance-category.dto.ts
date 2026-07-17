import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, IsBoolean, MaxLength} from 'class-validator';

export class UpdateFinanceCategoryDto {
  @ApiPropertyOptional({description: 'Category name'})
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({description: 'Active flag (soft-delete = false)'})
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

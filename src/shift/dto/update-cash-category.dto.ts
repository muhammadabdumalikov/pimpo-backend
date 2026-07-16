import {ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
  MaxLength,
} from 'class-validator';

export class UpdateCashCategoryDto {
  @ApiPropertyOptional({description: 'Category name'})
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({enum: ['in', 'out', 'both']})
  @IsString()
  @IsOptional()
  @IsIn(['in', 'out', 'both'])
  direction?: 'in' | 'out' | 'both';

  @ApiPropertyOptional({description: 'Active flag (soft-delete)'})
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

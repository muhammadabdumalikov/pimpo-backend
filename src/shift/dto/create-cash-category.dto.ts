import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, IsIn, MaxLength} from 'class-validator';

export class CreateCashCategoryDto {
  @ApiProperty({description: 'Category name (e.g. "Do\'kon xarajati")'})
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Which operation the category applies to',
    enum: ['in', 'out', 'both'],
    default: 'both',
  })
  @IsString()
  @IsOptional()
  @IsIn(['in', 'out', 'both'])
  direction?: 'in' | 'out' | 'both';
}

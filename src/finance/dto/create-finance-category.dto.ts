import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsString,
  IsIn,
  MaxLength,
  IsBoolean,
  IsOptional,
} from 'class-validator';

export class CreateFinanceCategoryDto {
  @ApiProperty({description: 'Category name', example: 'Arenda'})
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({description: 'Category kind', enum: ['income', 'expense']})
  @IsString()
  @IsIn(['income', 'expense'])
  kind: 'income' | 'expense';

  @ApiPropertyOptional({
    description: 'Capital money (owner in/out) — kept out of the P&L',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isCapital?: boolean;
}

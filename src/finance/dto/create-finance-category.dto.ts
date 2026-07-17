import {ApiProperty} from '@nestjs/swagger';
import {IsString, IsIn, MaxLength} from 'class-validator';

export class CreateFinanceCategoryDto {
  @ApiProperty({description: 'Category name', example: 'Arenda'})
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({description: 'Category kind', enum: ['income', 'expense']})
  @IsString()
  @IsIn(['income', 'expense'])
  kind: 'income' | 'expense';
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

export class CreateCategoryDto {
  @ApiProperty({ description: 'Category ID (slug)', example: 'mix' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  id: string;

  @ApiProperty({ description: 'Category name', example: 'Cмесь' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ description: 'Image URL', required: false })
  @IsString()
  @IsOptional()
  image?: string;
}

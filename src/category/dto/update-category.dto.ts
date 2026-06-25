import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

export class UpdateCategoryDto {
  @ApiProperty({ description: 'Category name', example: 'Cмесь', required: false })
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  @ApiProperty({ description: 'Image URL', required: false })
  @IsString()
  @IsOptional()
  image?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateBrandDto {
  @ApiPropertyOptional({ description: 'Brand name', example: 'Bosch' })
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Whether the brand is active' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

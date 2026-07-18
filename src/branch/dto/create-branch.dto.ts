import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength, MinLength } from 'class-validator';

export class CreateBranchDto {
  @ApiProperty({ description: 'Branch (do\'kon) name', example: 'Chilonzor filiali' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ description: 'Address', example: 'Toshkent, Chilonzor' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  address?: string;
}

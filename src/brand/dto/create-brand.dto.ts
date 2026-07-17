import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBrandDto {
  @ApiProperty({ description: 'Brand name', example: 'Bosch' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;
}

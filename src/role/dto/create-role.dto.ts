import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsOptional,
  MinLength,
  MaxLength,
} from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ description: 'Role name', example: 'Cashier' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiProperty({
    description: 'Allowed sidebar menu keys',
    example: ['ecommerce.products', 'checkout'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  menuKeys: string[];
}

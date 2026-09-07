import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsOptional,
  MinLength,
  MaxLength,
  IsIn,
} from 'class-validator';
import { PERMISSION_KEYS } from '../../permission/permission.catalog';

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

  @ApiProperty({
    description:
      'Action permissions granted to this role. Only keys from the server ' +
      'catalogue are accepted — an unknown key is a typo, never a silent grant.',
    example: ['receipt:receive'],
    type: [String],
    required: false,
  })
  @IsArray()
  @IsString({ each: true })
  @IsIn(PERMISSION_KEYS as string[], { each: true })
  @IsOptional()
  permissions?: string[];
}

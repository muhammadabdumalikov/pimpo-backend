import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsOptional,
  IsBoolean,
  MinLength,
  MaxLength,
  IsIn,
} from 'class-validator';
import { PERMISSION_KEYS } from '../../permission/permission.catalog';

export class UpdateRoleDto {
  @ApiProperty({ description: 'Role name', required: false })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @ApiProperty({
    description:
      'DEPRECATED and ignored — menu keys are derived from `permissions` on ' +
      'the server (see menu-derivation.ts).',
    type: [String],
    required: false,
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  menuKeys?: string[];

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

  @ApiProperty({ description: 'Whether the role is active', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

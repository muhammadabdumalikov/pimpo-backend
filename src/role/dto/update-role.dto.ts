import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsOptional,
  IsBoolean,
  MinLength,
  MaxLength,
} from 'class-validator';

export class UpdateRoleDto {
  @ApiProperty({ description: 'Role name', required: false })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'Allowed sidebar menu keys',
    type: [String],
    required: false,
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  menuKeys?: string[];

  @ApiProperty({ description: 'Whether the role is active', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

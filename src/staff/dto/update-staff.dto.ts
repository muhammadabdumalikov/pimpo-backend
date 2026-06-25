import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  MinLength,
  MaxLength,
} from 'class-validator';

export class UpdateStaffDto {
  @ApiProperty({ description: 'Staff display name', required: false })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @ApiProperty({ description: 'Assigned role id', required: false })
  @IsString()
  @MinLength(1)
  @IsOptional()
  roleId?: string;

  @ApiProperty({ description: 'New password (resets it)', required: false })
  @IsString()
  @MinLength(6)
  @IsOptional()
  password?: string;

  @ApiProperty({ description: 'Whether the staff account is active', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

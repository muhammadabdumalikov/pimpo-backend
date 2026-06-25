import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';

export class CreateStaffDto {
  @ApiProperty({ description: 'Staff display name', example: 'Ali Valiyev' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: 'Login username (globally unique)', example: 'ali_cashier' })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  login: string;

  @ApiProperty({ description: 'Password', example: 'securePassword123' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ description: 'Assigned role id' })
  @IsString()
  @MinLength(1)
  roleId: string;
}

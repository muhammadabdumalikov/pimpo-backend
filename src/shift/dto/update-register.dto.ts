import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, IsBoolean, MaxLength} from 'class-validator';

export class UpdateRegisterDto {
  @ApiPropertyOptional({description: 'Register (kassa) name'})
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({description: 'Active flag (soft-disable)'})
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: "Branch (do'kon) this register sells from",
  })
  @IsString()
  @IsOptional()
  @MaxLength(36)
  branchId?: string;
}

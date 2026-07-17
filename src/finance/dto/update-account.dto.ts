import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, IsBoolean, MaxLength} from 'class-validator';

export class UpdateAccountDto {
  @ApiPropertyOptional({description: 'Account name'})
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({description: 'Active flag'})
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

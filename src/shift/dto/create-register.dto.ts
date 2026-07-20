import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, MaxLength} from 'class-validator';

export class CreateRegisterDto {
  @ApiProperty({description: 'Register (kassa) name'})
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({description: 'Store id (future multi-store)'})
  @IsString()
  @IsOptional()
  @MaxLength(36)
  storeId?: string;

  @ApiPropertyOptional({
    description:
      "Branch (do'kon) this register sells from; defaults to default",
  })
  @IsString()
  @IsOptional()
  @MaxLength(36)
  branchId?: string;
}

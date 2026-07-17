import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsIn, IsOptional, MaxLength} from 'class-validator';

export class CreateAccountDto {
  @ApiProperty({description: 'Account name', example: 'Bank hisobi'})
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({description: 'Account type', enum: ['cash', 'noncash']})
  @IsString()
  @IsIn(['cash', 'noncash'])
  type: 'cash' | 'noncash';

  @ApiPropertyOptional({description: 'Linked cash register id (cash accounts)'})
  @IsString()
  @IsOptional()
  registerId?: string;
}

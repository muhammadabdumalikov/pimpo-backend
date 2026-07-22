import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsNumber, IsOptional, IsString, Matches, Min} from 'class-validator';

export class SetTargetDto {
  @ApiPropertyOptional({description: 'YYYY-MM (default: current month)'})
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, {message: 'month must be YYYY-MM'})
  month?: string;

  @ApiProperty({description: 'Monthly revenue target in UZS'})
  @IsNumber()
  @Min(0)
  revenueTarget: number;
}

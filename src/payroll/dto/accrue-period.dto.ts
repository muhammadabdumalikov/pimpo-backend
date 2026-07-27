import {ApiProperty} from '@nestjs/swagger';
import {IsArray, IsOptional, IsString} from 'class-validator';

export class AccruePeriodDto {
  @ApiProperty({
    description:
      'Employees to accrue. Omit to accrue every payroll-enabled employee ' +
      'who has not been accrued for this period yet.',
    required: false,
    type: [String],
  })
  @IsArray()
  @IsString({each: true})
  @IsOptional()
  staffIds?: string[];
}

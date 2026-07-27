import {ApiProperty} from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAdjustmentDto {
  @ApiProperty({description: 'Amount, UZS (always positive)', example: 500000})
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({
    description:
      "'bonus' (mukofot) increases what is owed; 'deduction' (jarima) reduces it",
    enum: ['bonus', 'deduction'],
  })
  @IsIn(['bonus', 'deduction'])
  type: 'bonus' | 'deduction';

  @ApiProperty({description: 'Reason', required: false})
  @IsString()
  @MaxLength(500)
  @IsOptional()
  note?: string;
}

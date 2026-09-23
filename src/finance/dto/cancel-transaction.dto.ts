import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsBoolean, IsOptional} from 'class-validator';

/** Storno of a manual transaction. */
export class CancelTransactionDto {
  @ApiPropertyOptional({
    description:
      'Go ahead even if taking the money back leaves a balance below zero',
  })
  @IsBoolean()
  @IsOptional()
  allowNegative?: boolean;
}

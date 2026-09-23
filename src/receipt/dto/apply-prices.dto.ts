import {ApiProperty} from '@nestjs/swagger';
import {ArrayMinSize, IsArray, IsString} from 'class-validator';

/**
 * Which products' cards take the prices this receipt names. Explicit ids, never
 * "all": the point of the review step is that somebody looked at each line.
 */
export class ApplyPricesDto {
  @ApiProperty({
    description: 'Product ids to reprice, from the receipt price suggestions',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({each: true})
  productIds: string[];
}

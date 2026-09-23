import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsArray, IsOptional, IsString} from 'class-validator';

/**
 * What the shop decided about the selling prices this receipt names, one list
 * per direction. Explicit ids, never "all": the point of the review step is
 * that somebody looked at each line.
 *
 * `applyToCard` — the receipt was right: the product card takes its price.
 * `applyToReceipt` — the card was right and the receipt line carries a typo:
 * the line takes the card's price instead, so the document and the shelf agree
 * and the difference stops being reported for ever.
 *
 * A product named in neither list is left alone and keeps showing as a
 * difference — that is what closing the dialog does.
 */
export class ApplyPricesDto {
  @ApiPropertyOptional({
    description: "Products whose card takes the receipt's price",
    type: [String],
  })
  @IsArray()
  @IsOptional()
  @IsString({each: true})
  applyToCard?: string[];

  @ApiPropertyOptional({
    description: "Products whose receipt line takes the card's price",
    type: [String],
  })
  @IsArray()
  @IsOptional()
  @IsString({each: true})
  applyToReceipt?: string[];
}

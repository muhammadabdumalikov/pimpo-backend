import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional} from 'class-validator';

/**
 * Editable metadata of a completed sale (BiLLZ-style "edit transaction").
 * Money, items, stock and the sale timestamp are immutable here — only the
 * customer, cashier and note change. `null` clears a field; `undefined`
 * (absent) leaves it untouched.
 */
export class UpdateOrderDto {
  @ApiPropertyOptional({description: 'Customer id (null clears the customer)'})
  @IsString()
  @IsOptional()
  userId?: string | null;

  @ApiPropertyOptional({description: 'Customer name snapshot'})
  @IsString()
  @IsOptional()
  customerName?: string | null;

  @ApiPropertyOptional({
    description: 'Cashier (staff or owner account id; null clears)',
  })
  @IsString()
  @IsOptional()
  cashierId?: string | null;

  @ApiPropertyOptional({description: 'Note (null clears)'})
  @IsString()
  @IsOptional()
  note?: string | null;
}

import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** "Ta'minotchiga to'lov": till money handed to a supplier's agent. */
export class PaySupplierDto {
  @ApiProperty({description: 'Supplier id'})
  @IsString()
  supplierId: string;

  @ApiProperty({
    description:
      'Amount (> 0). Settles the open receipts oldest first; the rest becomes the supplier advance.',
  })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({
    description: 'Cash (naqd) or non-cash (naqdsiz)',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  isCash?: boolean;

  @ApiPropertyOptional({enum: ['UZS', 'USD'], default: 'UZS'})
  @IsString()
  @IsOptional()
  @IsIn(['UZS', 'USD'])
  currency?: 'UZS' | 'USD';

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

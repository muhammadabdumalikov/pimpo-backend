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

/** "Avansni o'tkazish": move a supplier's advance to another supplier. */
export class TransferAdvanceDto {
  @ApiProperty({description: 'Supplier the advance moves to'})
  @IsString()
  toSupplierId: string;

  @ApiProperty({description: "Amount (> 0, at most the source's advance)"})
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({enum: ['UZS', 'USD'], default: 'UZS'})
  @IsString()
  @IsOptional()
  @IsIn(['UZS', 'USD'])
  currency?: 'UZS' | 'USD';

  @ApiPropertyOptional({
    description:
      "Then pay the new supplier's open receipts from it, oldest first",
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  settle?: boolean;

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

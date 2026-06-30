import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateReceiptSettingsDto {
  @ApiPropertyOptional({ description: 'Display name of the receipt template' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  receiptName?: string;

  @ApiPropertyOptional({ description: 'Whether to show the business logo' })
  @IsOptional()
  @IsBoolean()
  showLogo?: boolean;

  @ApiPropertyOptional({
    description: 'Logo image URL (null clears the logo)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  logoUrl?: string | null;

  @ApiPropertyOptional({ description: 'Whether VAT (QQS) is applied' })
  @IsOptional()
  @IsBoolean()
  vatEnabled?: boolean;

  @ApiPropertyOptional({ description: 'VAT (QQS) rate in percent', example: 12 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  vatRate?: number;

  @ApiPropertyOptional({
    description: 'Inventory costing method for COGS',
    enum: ['AVERAGE', 'FIFO'],
  })
  @IsOptional()
  @IsIn(['AVERAGE', 'FIFO'])
  costingMethod?: 'AVERAGE' | 'FIFO';

  @ApiPropertyOptional({
    description:
      'What happens to existing stock selling price when a receipt arrives at a ' +
      'higher price: keep old batches or reprice them up',
    enum: ['KEEP_OLD', 'REPRICE_EXISTING'],
  })
  @IsOptional()
  @IsIn(['KEEP_OLD', 'REPRICE_EXISTING'])
  priceIncreaseMode?: 'KEEP_OLD' | 'REPRICE_EXISTING';
}

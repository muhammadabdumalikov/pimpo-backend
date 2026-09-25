import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsString,
  IsNumber,
  Min,
  IsOptional,
  MaxLength,
  ValidateNested,
  ArrayNotEmpty,
} from 'class-validator';
import {Type} from 'class-transformer';
import {WRITE_OFF_REASONS, WriteOffReason} from '../../common/loss-reasons';

export class WriteOffItemDto {
  @ApiProperty({description: 'Product id being written off'})
  @IsString()
  productId: string;

  @ApiProperty({
    description: 'Quantity to remove from stock (> 0). Fractional kg for weighed goods.',
  })
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  qty: number;

  @ApiPropertyOptional({
    enum: WRITE_OFF_REASONS,
    description: 'Per-item reason code (overrides the document reasonCode)',
  })
  @IsIn(WRITE_OFF_REASONS)
  @IsOptional()
  reasonCode?: WriteOffReason;

  @ApiPropertyOptional({
    description:
      'Per-item free-text note (overrides the document reason). Required ' +
      "when the item's reason code is 'other'.",
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  reason?: string;
}

export class CreateWriteOffDto {
  @ApiProperty({type: [WriteOffItemDto], description: 'Items to write off'})
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({each: true})
  @Type(() => WriteOffItemDto)
  items: WriteOffItemDto[];

  @ApiPropertyOptional({description: 'Custom name (auto-generated if omitted)'})
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    enum: WRITE_OFF_REASONS,
    description: 'Default reason code applied to items without one',
  })
  @IsIn(WRITE_OFF_REASONS)
  @IsOptional()
  reasonCode?: WriteOffReason;

  @ApiPropertyOptional({description: 'Default free-text note applied to items without one'})
  @IsString()
  @IsOptional()
  @MaxLength(255)
  reason?: string;

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

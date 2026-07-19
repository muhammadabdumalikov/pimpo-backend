import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsArray,
  IsString,
  IsNumber,
  Min,
  IsOptional,
  MaxLength,
  ValidateNested,
  ArrayNotEmpty,
} from 'class-validator';
import {Type} from 'class-transformer';

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

  @ApiPropertyOptional({description: 'Per-item reason (overrides the document reason)'})
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

  @ApiPropertyOptional({description: 'Default reason applied to items without one'})
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

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

export class CountItemDto {
  @ApiProperty({description: 'Product id being counted'})
  @IsString()
  productId: string;

  @ApiProperty({
    description:
      'Actual counted quantity (>= 0). Fractional kg for weighed goods (max 3 decimals).',
  })
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0)
  countedQty: number;

  @ApiPropertyOptional({description: 'Reason for the difference (theft/damage/…)'})
  @IsString()
  @IsOptional()
  @MaxLength(255)
  reason?: string;
}

export class CountItemsDto {
  @ApiProperty({type: [CountItemDto], description: 'Counted rows to upsert'})
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({each: true})
  @Type(() => CountItemDto)
  items: CountItemDto[];
}

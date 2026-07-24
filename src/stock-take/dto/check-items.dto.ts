import {ApiProperty} from '@nestjs/swagger';
import {
  IsArray,
  IsString,
  IsBoolean,
  ValidateNested,
  ArrayNotEmpty,
} from 'class-validator';
import {Type} from 'class-transformer';

export class CheckItemDto {
  @ApiProperty({description: 'Product id whose checked flag changes'})
  @IsString()
  productId: string;

  @ApiProperty({
    description:
      'Whether the counter has reviewed this product ("tekshirildi")',
  })
  @IsBoolean()
  checked: boolean;
}

export class CheckItemsDto {
  @ApiProperty({
    type: [CheckItemDto],
    description: 'Checked-flag changes to apply',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({each: true})
  @Type(() => CheckItemDto)
  items: CheckItemDto[];
}

import {ApiProperty} from '@nestjs/swagger';
import {
  IsArray,
  IsString,
  IsInt,
  Min,
  ValidateNested,
  ArrayNotEmpty,
} from 'class-validator';
import {Type} from 'class-transformer';

export class CountItemDto {
  @ApiProperty({description: 'Product id being counted'})
  @IsString()
  productId: string;

  @ApiProperty({description: 'Actual counted quantity (>= 0)'})
  @IsInt()
  @Min(0)
  countedQty: number;
}

export class CountItemsDto {
  @ApiProperty({type: [CountItemDto], description: 'Counted rows to upsert'})
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({each: true})
  @Type(() => CountItemDto)
  items: CountItemDto[];
}

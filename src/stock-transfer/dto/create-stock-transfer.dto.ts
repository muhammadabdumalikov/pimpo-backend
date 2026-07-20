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

export class TransferItemDto {
  @ApiProperty({description: 'Product id being moved'})
  @IsString()
  productId: string;

  @ApiProperty({
    description:
      'Quantity to move from source to destination (> 0). Fractional kg for weighed goods.',
  })
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  quantity: number;
}

export class CreateStockTransferDto {
  @ApiProperty({description: "Source branch (do'kon) id — stock leaves here"})
  @IsString()
  @MaxLength(36)
  fromBranchId: string;

  @ApiProperty({
    description: "Destination branch (do'kon) id — stock arrives here",
  })
  @IsString()
  @MaxLength(36)
  toBranchId: string;

  @ApiProperty({type: [TransferItemDto], description: 'Items to move'})
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({each: true})
  @Type(() => TransferItemDto)
  items: TransferItemDto[];

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

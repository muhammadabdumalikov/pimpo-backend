import {ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type {ScaleValueMode} from '../../common/weight-barcode';

// One barcode layout the shop's scales print. Widths are bounded so a saved
// format can always describe a real barcode: the narrowest useful label is a
// prefix plus one PLU digit and one value digit, the widest in practice is the
// 18-digit in-store code.
export class ScaleBarcodeFormatDto {
  @ApiPropertyOptional({
    description: 'Leading digits that mark a scale label',
    example: '22',
  })
  @IsString()
  @Matches(/^\d{1,3}$/, {message: 'prefix must be 1-3 digits'})
  prefix!: string;

  @ApiPropertyOptional({description: 'Width of the PLU field', example: 5})
  @IsInt()
  @Min(1)
  @Max(8)
  pluDigits!: number;

  @ApiPropertyOptional({description: 'Width of the value field', example: 5})
  @IsInt()
  @Min(1)
  @Max(9)
  valueDigits!: number;

  @ApiPropertyOptional({
    description: "Whether the value field holds an amount or a line total",
    enum: ['weight', 'price'],
  })
  @IsIn(['weight', 'price'])
  mode!: ScaleValueMode;

  @ApiPropertyOptional({
    description: "Divides the raw value into kg or so'm (1000 = grams)",
    example: 1000,
  })
  @IsInt()
  @Min(1)
  @Max(1000000)
  divisor!: number;

  @ApiPropertyOptional({
    description: 'Whether a trailing check/filler digit closes the code',
  })
  @IsBoolean()
  checkDigit!: boolean;
}

export class UpdateScaleSettingsDto {
  @ApiPropertyOptional({
    description: 'Master switch — off means scans are never read as labels',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Barcode layouts the shop\'s scales print, tried in order',
    type: [ScaleBarcodeFormatDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({each: true})
  @Type(() => ScaleBarcodeFormatDto)
  formats?: ScaleBarcodeFormatDto[];
}

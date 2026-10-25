import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class MenuImportRowDto {
  @ApiProperty({example: 'Капучино сингл'})
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    description: 'Category name; created when missing',
    example: 'Кофе',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  category?: string;

  @ApiProperty({description: 'Selling price', example: 22000})
  @IsNumber({maxDecimalPlaces: 2})
  @Min(0)
  @Max(1_000_000_000)
  price: number;

  @ApiPropertyOptional({
    description: 'Cost of one dish, used while it has no recipe',
    example: 10650,
  })
  @IsOptional()
  @IsNumber({maxDecimalPlaces: 2})
  @Min(0)
  @Max(1_000_000_000)
  cost?: number;
}

export class MenuImportDto {
  @ApiProperty({type: [MenuImportRowDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({each: true})
  @Type(() => MenuImportRowDto)
  rows: MenuImportRowDto[];
}

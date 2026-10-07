import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsNotEmpty,
  MaxLength,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class RecipeLineDto {
  @ApiProperty({description: 'Component card (stock, semi or dish)'})
  @IsString()
  @IsNotEmpty()
  componentId: string;

  @ApiProperty({
    description:
      "Amount in the component's own unit (0.12 for 120 g of a kg card).",
    example: 0.12,
  })
  @IsNumber({maxDecimalPlaces: 4})
  quantity: number;

  @ApiPropertyOptional({
    description: 'Packaging: drawn only when the sale is takeaway.',
  })
  @IsOptional()
  @IsBoolean()
  takeawayOnly?: boolean;
}

export class SaveRecipeDto {
  @ApiProperty({type: [RecipeLineDto]})
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({each: true})
  @Type(() => RecipeLineDto)
  lines: RecipeLineDto[];

  @ApiPropertyOptional({
    description:
      "Semi-finished only: how much one batch of this recipe makes, in the card's unit.",
    example: 2,
  })
  @IsOptional()
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  recipeYield?: number;
}

export class UpdateFoodSettingsDto {
  @ApiPropertyOptional({
    description: 'Ready-made kitchen notes offered on a line.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({each: true})
  @MaxLength(60, {each: true})
  notePresets?: string[];

  @ApiPropertyOptional({
    description: 'Food-cost share (percent) above which a dish is flagged.',
    example: 35,
  })
  @IsOptional()
  @IsNumber({maxDecimalPlaces: 2})
  @Min(1)
  @Max(100)
  foodCostTarget?: number;
}

import {ApiPropertyOptional, ApiProperty} from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Multipart fields arrive as text, so everything here is a string. The photo
 * itself is the `photo` file part; `sourceImageUrl` instead points at one of
 * our own S3 images (the product's current picture).
 */
export class DescribeProductImageDto {
  @ApiProperty({description: 'Product name as the shop wrote it'})
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional({description: 'Unit name, e.g. "Dona", "Kilogramm"'})
  @IsOptional()
  @IsString()
  @MaxLength(60)
  unit?: string;

  @ApiPropertyOptional({description: 'One of our own image URLs to read'})
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceImageUrl?: string;
}

export class GenerateProductImageDto {
  @ApiProperty({description: 'Packaging description (edited by the shop)'})
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description: string;

  @ApiPropertyOptional({description: 'The card this is for, when it exists'})
  @IsOptional()
  @IsString()
  @MaxLength(36)
  productId?: string;

  @ApiPropertyOptional({description: 'One of our own image URLs to redo'})
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceImageUrl?: string;
}

/**
 * Platform console. `monthlyLimitUsd`: number sets it, null = back to the
 * default, absent = unchanged. `bonusUsd`: this month's top-up (0 clears it).
 */
export class SetAiImageQuotaDto {
  @ApiPropertyOptional({nullable: true, minimum: 0, maximum: 1000})
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  monthlyLimitUsd?: number | null;

  @ApiPropertyOptional({minimum: 0, maximum: 1000})
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  bonusUsd?: number;
}

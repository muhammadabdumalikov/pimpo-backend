import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreatePaymentMethodDto {
  @ApiProperty({ description: 'Display name', example: 'Payme' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: 'Sort position (lower first)', example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdatePaymentMethodDto extends PartialType(CreatePaymentMethodDto) {
  @ApiPropertyOptional({ description: 'Show/hide this method at the till' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}

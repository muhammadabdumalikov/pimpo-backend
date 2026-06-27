import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateReceiptSettingsDto {
  @ApiPropertyOptional({ description: 'Display name of the receipt template' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  receiptName?: string;

  @ApiPropertyOptional({ description: 'Whether to show the business logo' })
  @IsOptional()
  @IsBoolean()
  showLogo?: boolean;

  @ApiPropertyOptional({
    description: 'Logo image URL (null clears the logo)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  logoUrl?: string | null;
}

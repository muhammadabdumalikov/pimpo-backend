import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsBoolean, IsInt, IsOptional, Max, Min} from 'class-validator';

/**
 * Edit the shop's label ("Etiketka") layout. Every field is optional — the
 * settings page saves the whole form, but a caller may send one toggle.
 *
 * The millimetre bounds are the label stock a thermal printer can actually
 * take (Xprinter 365B and the like top out around 80 mm wide); the rest are
 * sanity bounds, so a typo can't produce a label nothing prints on.
 */
export class UpdateLabelSettingsDto {
  @ApiPropertyOptional({description: 'Label width in mm (20–80)'})
  @IsOptional()
  @IsInt()
  @Min(20)
  @Max(80)
  widthMm?: number;

  @ApiPropertyOptional({description: 'Label height in mm (15–120)'})
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(120)
  heightMm?: number;

  @ApiPropertyOptional({description: 'Quiet zone inside the label, mm (0–10)'})
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  paddingMm?: number;

  @ApiPropertyOptional({description: 'Print the shop name on the label'})
  @IsOptional()
  @IsBoolean()
  showStoreName?: boolean;

  @ApiPropertyOptional({description: 'Print the product name'})
  @IsOptional()
  @IsBoolean()
  showName?: boolean;

  @ApiPropertyOptional({description: 'Lines the product name may take (1–3)'})
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  nameLines?: number;

  @ApiPropertyOptional({description: 'Print the selling price'})
  @IsOptional()
  @IsBoolean()
  showPrice?: boolean;

  @ApiPropertyOptional({description: 'Print the product code (artikul)'})
  @IsOptional()
  @IsBoolean()
  showCode?: boolean;

  @ApiPropertyOptional({description: 'Print the barcode bars themselves'})
  @IsOptional()
  @IsBoolean()
  showBarcode?: boolean;

  @ApiPropertyOptional({description: 'Print the digits under the bars'})
  @IsOptional()
  @IsBoolean()
  showBarcodeText?: boolean;

  @ApiPropertyOptional({description: 'Print the scale code (PLU)'})
  @IsOptional()
  @IsBoolean()
  showPlu?: boolean;

  @ApiPropertyOptional({description: 'Height of the bars in mm (5–40)'})
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(40)
  barcodeHeightMm?: number;

  @ApiPropertyOptional({description: 'Type scale for the label, % (80–140)'})
  @IsOptional()
  @IsInt()
  @Min(80)
  @Max(140)
  fontScale?: number;

  @ApiPropertyOptional({description: 'Copies one print sends (1–50)'})
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  copies?: number;
}

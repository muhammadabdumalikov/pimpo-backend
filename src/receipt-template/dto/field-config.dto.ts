import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsBoolean, IsOptional, IsString, MaxLength} from 'class-validator';

// One entry in `infoFields` / `footerLinks`: a field key, whether it is shown,
// and (footer links only) an optional value (social handle / url).
export class FieldConfigDto {
  @ApiProperty({description: 'Field key', example: 'storeName'})
  @IsString()
  @MaxLength(50)
  key!: string;

  @ApiProperty({description: 'Whether the field is shown'})
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({description: 'Value (footer links only)'})
  @IsOptional()
  @IsString()
  @MaxLength(500)
  value?: string;
}

import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {FieldConfigDto} from './field-config.dto';

export class CreateReceiptTemplateDto {
  @ApiProperty({description: 'Template display name'})
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({enum: ['receipt', 'waybill'], default: 'receipt'})
  @IsOptional()
  @IsIn(['receipt', 'waybill'])
  printType?: 'receipt' | 'waybill';

  @ApiPropertyOptional({
    description: 'Register this template applies to (null = business default)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(36)
  registerId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showLogo?: boolean;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  logoUrl?: string | null;

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  extraImageUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showCustomerBalance?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showCustomerDebt?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showProductAttributes?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showPoweredBy?: boolean;

  @ApiPropertyOptional({type: [FieldConfigDto]})
  @IsOptional()
  @IsArray()
  @ValidateNested({each: true})
  @Type(() => FieldConfigDto)
  infoFields?: FieldConfigDto[];

  @ApiPropertyOptional({type: [FieldConfigDto]})
  @IsOptional()
  @IsArray()
  @ValidateNested({each: true})
  @Type(() => FieldConfigDto)
  footerLinks?: FieldConfigDto[];

  @ApiPropertyOptional({nullable: true})
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  footerText?: string | null;

  @ApiPropertyOptional({description: 'Make this the business-wide default'})
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

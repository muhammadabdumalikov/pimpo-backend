import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, IsNumber, Min} from 'class-validator';

export class OpenShiftDto {
  @ApiProperty({description: 'Register (kassa) to open the shift on'})
  @IsString()
  registerId: string;

  @ApiPropertyOptional({
    description: "Opening cash float (so'm)",
    default: 0,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  openingFloat?: number;

  @ApiPropertyOptional({description: 'Opening note'})
  @IsString()
  @IsOptional()
  note?: string;
}

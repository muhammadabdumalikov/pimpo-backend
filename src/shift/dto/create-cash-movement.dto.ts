import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsIn,
  IsNumber,
  IsBoolean,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateCashMovementDto {
  @ApiProperty({description: 'Direction', enum: ['in', 'out']})
  @IsString()
  @IsIn(['in', 'out'])
  type: 'in' | 'out';

  @ApiProperty({description: 'Amount (> 0)'})
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({
    description: 'Cash (naqd) or non-cash (naqdsiz)',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  isCash?: boolean;

  @ApiPropertyOptional({enum: ['UZS', 'USD'], default: 'UZS'})
  @IsString()
  @IsOptional()
  @IsIn(['UZS', 'USD'])
  currency?: 'UZS' | 'USD';

  @ApiPropertyOptional({description: 'Category (Toifa) id'})
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

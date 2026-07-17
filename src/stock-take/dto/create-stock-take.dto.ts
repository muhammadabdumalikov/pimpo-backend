import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsOptional, IsIn, MaxLength} from 'class-validator';

export class CreateStockTakeDto {
  @ApiProperty({description: 'Stock-take type', enum: ['full', 'partial']})
  @IsString()
  @IsIn(['full', 'partial'])
  type: 'full' | 'partial';

  @ApiPropertyOptional({description: 'Store id (future: multi-store)'})
  @IsString()
  @IsOptional()
  storeId?: string;

  @ApiPropertyOptional({description: 'Custom name (auto-generated if omitted)'})
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({description: 'Free-form note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

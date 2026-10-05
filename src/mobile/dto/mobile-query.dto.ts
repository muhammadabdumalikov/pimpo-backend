import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsDateString, IsIn, IsOptional, IsString} from 'class-validator';

export class MobileHomeQueryDto {
  @ApiPropertyOptional({enum: ['today', 'week', 'month'], default: 'today'})
  @IsIn(['today', 'week', 'month'])
  @IsOptional()
  period?: 'today' | 'week' | 'month';
}

/** Day headers of the phone sales list — mirrors GET /orders filters. */
export class MobileSalesDaysQueryDto {
  @ApiProperty({description: 'From business day (YYYY-MM-DD, inclusive)'})
  @IsDateString()
  from!: string;

  @ApiProperty({description: 'To business day (YYYY-MM-DD, inclusive)'})
  @IsDateString()
  to!: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  registerId?: string;

  @ApiPropertyOptional({description: "Seller id, or 'none'"})
  @IsString()
  @IsOptional()
  sellerId?: string;
}

export class MobileStockQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  branchId?: string;
}

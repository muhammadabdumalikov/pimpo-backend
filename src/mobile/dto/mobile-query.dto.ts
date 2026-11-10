import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

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

  @ApiPropertyOptional({
    description: 'Id the sale is credited to: its seller, else its cashier',
  })
  @IsString()
  @IsOptional()
  creditedTo?: string;
}

export class MobileStockQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  branchId?: string;
}

/** A payment taken from a customer who owes the shop. */
export class MobileDebtPaymentDto {
  @ApiProperty({description: 'Amount received, so\'m (at most the balance)'})
  @IsNumber({maxDecimalPlaces: 2})
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({enum: ['cash', 'card'], default: 'cash'})
  @IsIn(['cash', 'card'])
  @IsOptional()
  method?: 'cash' | 'card';
}

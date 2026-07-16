import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsIn,
  IsNumber,
  IsArray,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CountedEntryDto {
  @ApiProperty({enum: ['cash', 'card', 'debt']})
  @IsString()
  @IsIn(['cash', 'card', 'debt'])
  method: 'cash' | 'card' | 'debt';

  @ApiProperty({enum: ['UZS', 'USD']})
  @IsString()
  @IsIn(['UZS', 'USD'])
  currency: 'UZS' | 'USD';

  @ApiProperty({description: 'Amount the cashier actually counted'})
  @IsNumber()
  @Min(0)
  amount: number;
}

export class CloseShiftDto {
  @ApiPropertyOptional({
    description: 'Counted amounts per payment type × currency',
    type: [CountedEntryDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({each: true})
  @Type(() => CountedEntryDto)
  counted?: CountedEntryDto[];

  @ApiPropertyOptional({description: 'USD → UZS rate at close (if USD used)'})
  @IsNumber()
  @IsOptional()
  @Min(0)
  usdRate?: number;

  @ApiPropertyOptional({description: 'Closing note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

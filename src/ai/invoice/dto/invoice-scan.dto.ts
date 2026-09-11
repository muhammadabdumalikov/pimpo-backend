import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * A scan as the drawer writes it — on creation (right after the first read)
 * and on every autosave. The whole review, last write wins.
 */
export class SaveScanDto {
  @ApiProperty({description: 'Review snapshot, opaque to the server'})
  @IsObject()
  state: Record<string, unknown>;

  @ApiProperty({description: 'Rows in the review, for the list'})
  @IsInt()
  @Min(0)
  @Max(10000)
  rowCount: number;

  @ApiProperty({description: 'Sheets read into the review, for the list'})
  @IsInt()
  @Min(0)
  @Max(100)
  pageCount: number;

  @ApiProperty({
    description: 'Products made for rows of this scan',
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({each: true})
  @MaxLength(36, {each: true})
  createdProductIds: string[];

  @ApiPropertyOptional({description: 'Supplier as read off the note'})
  @IsOptional()
  @IsString()
  @MaxLength(255)
  supplierName?: string | null;

  @ApiPropertyOptional({description: 'Document number as read off the note'})
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string | null;

  @ApiPropertyOptional({description: 'Document date as read (YYYY-MM-DD)'})
  @IsOptional()
  @IsString()
  @MaxLength(10)
  documentDate?: string | null;
}

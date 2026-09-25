import {ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {Type} from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  DEFECTIVE_IN_REASONS,
  DefectiveInReason,
  SUPPLIER_RETURN_REASONS,
  SupplierReturnReason,
  WRITE_OFF_REASONS,
  WriteOffReason,
} from '../../common/loss-reasons';

// Request bodies for the yaroqsiz tovarlar ombori moves. Every move names the
// branch whose defective stock it touches (omitted = the default branch) and
// lines of product + quantity; reason codes and notes follow the same "line
// overrides the document" rule as write-offs and supplier returns.

class QtyLineDto {
  @ApiProperty({description: 'Product id'})
  @IsString()
  productId!: string;

  @ApiProperty({
    description: 'Quantity (> 0). Fractional kg for weighed goods.',
  })
  @IsNumber({maxDecimalPlaces: 3})
  @Min(0.001)
  qty!: number;
}

class NotedLineDto extends QtyLineDto {
  @ApiPropertyOptional({
    description: "Line note; required when its reason is 'other'",
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  note?: string;
}

class BranchDocDto {
  @ApiPropertyOptional({
    description: "Branch (do'kon); omitted = default branch",
  })
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({description: 'Document note'})
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}

// ── Sellable stock → defective stock ("yaroqsizga o'tkazish") ────────────────
export class ShelfLineDto extends NotedLineDto {
  @ApiPropertyOptional({enum: DEFECTIVE_IN_REASONS})
  @IsIn(DEFECTIVE_IN_REASONS)
  @IsOptional()
  reasonCode?: DefectiveInReason;
}
export class MoveToDefectiveDto extends BranchDocDto {
  @ApiProperty({type: [ShelfLineDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => ShelfLineDto)
  items!: ShelfLineDto[];

  @ApiPropertyOptional({
    enum: DEFECTIVE_IN_REASONS,
    description: 'Default for lines',
  })
  @IsIn(DEFECTIVE_IN_REASONS)
  @IsOptional()
  reasonCode?: DefectiveInReason;
}

// ── Opening defective stock (owner, first 30 days) ───────────────────────────
export class OpeningDefectiveDto extends BranchDocDto {
  @ApiProperty({type: [NotedLineDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => NotedLineDto)
  items!: NotedLineDto[];
}

// ── Defective stock → written off ────────────────────────────────────────────
export class DefectiveWriteOffLineDto extends NotedLineDto {
  @ApiPropertyOptional({enum: WRITE_OFF_REASONS})
  @IsIn(WRITE_OFF_REASONS)
  @IsOptional()
  reasonCode?: WriteOffReason;
}
export class WriteOffDefectiveDto extends BranchDocDto {
  @ApiProperty({type: [DefectiveWriteOffLineDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => DefectiveWriteOffLineDto)
  items!: DefectiveWriteOffLineDto[];

  @ApiPropertyOptional({
    enum: WRITE_OFF_REASONS,
    description: 'Default for lines',
  })
  @IsIn(WRITE_OFF_REASONS)
  @IsOptional()
  reasonCode?: WriteOffReason;
}

// ── Defective stock → back on sale ───────────────────────────────────────────
export class ReleaseDefectiveDto extends BranchDocDto {
  @ApiProperty({type: [QtyLineDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => QtyLineDto)
  items!: QtyLineDto[];
}

// ── Supplier swapped defective units for good ones ───────────────────────────
export class ExchangeDefectiveDto extends ReleaseDefectiveDto {
  @ApiPropertyOptional({description: 'Supplier who swapped the goods'})
  @IsString()
  @IsOptional()
  supplierId?: string;
}

// ── Defective stock → back to the supplier, off a receipt's debt ─────────────
export class DefectiveSupplierReturnLineDto extends NotedLineDto {
  @ApiPropertyOptional({enum: SUPPLIER_RETURN_REASONS})
  @IsIn(SUPPLIER_RETURN_REASONS)
  @IsOptional()
  reasonCode?: SupplierReturnReason;
}
export class DefectiveSupplierReturnDto extends BranchDocDto {
  @ApiProperty({description: 'Goods receipt whose debt the return reduces'})
  @IsString()
  receiptId!: string;

  @ApiProperty({type: [DefectiveSupplierReturnLineDto]})
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({each: true})
  @Type(() => DefectiveSupplierReturnLineDto)
  items!: DefectiveSupplierReturnLineDto[];

  @ApiPropertyOptional({
    enum: SUPPLIER_RETURN_REASONS,
    description: 'Default for lines',
  })
  @IsIn(SUPPLIER_RETURN_REASONS)
  @IsOptional()
  reasonCode?: SupplierReturnReason;
}

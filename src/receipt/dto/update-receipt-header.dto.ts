import {ApiPropertyOptional} from '@nestjs/swagger';
import {IsOptional, IsString, ValidateIf} from 'class-validator';

/**
 * Correct a receipt's header at any point in its life (unlike UpdateReceiptDto,
 * which replaces a draft wholesale). Only the two fields a shop actually needs
 * to fix after the fact: which supplier the goods came from, and which branch
 * ("do'kon") they landed in.
 *
 * An omitted field is left alone; `supplierId: null` clears the supplier.
 */
export class UpdateReceiptHeaderDto {
  @ApiPropertyOptional({
    description: 'Supplier id, or null to detach the supplier',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  supplierId?: string | null;

  @ApiPropertyOptional({
    description:
      'Branch the receipt belongs to. On a received receipt this moves what ' +
      'is left of its stock to the new branch.',
  })
  @IsOptional()
  @IsString()
  branchId?: string;
}

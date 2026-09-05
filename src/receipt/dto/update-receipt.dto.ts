import {ApiPropertyOptional, OmitType} from '@nestjs/swagger';
import {IsBoolean, IsOptional} from 'class-validator';
import {CreateReceiptDto} from './create-receipt.dto';

/**
 * Edit a receipt. The payload fully replaces the document — its header fields
 * and every line. `draft` is not accepted: editing never changes a receipt's
 * status, and POST /receipts/:id/receive is what applies a draft to stock.
 */
export class UpdateReceiptDto extends OmitType(CreateReceiptDto, [
  'draft',
] as const) {
  /**
   * Consent to rewrite a receipt that has ALREADY been received.
   *
   * Editing such a receipt takes its goods back off stock and puts the new
   * lines on — real inventory movement, not a document change. That must never
   * happen because a caller reused the same endpoint it uses for drafts: a
   * stale tab auto-saving, a mobile client, an integration. So it is refused
   * unless the caller says outright that this is what it means to do.
   *
   * Ignored for a draft, which holds nothing to rewrite.
   */
  @ApiPropertyOptional({
    description:
      'Required to edit an already-received receipt: its stock and cost are ' +
      'recomputed. Ignored for drafts.',
  })
  @IsOptional()
  @IsBoolean()
  amendReceived?: boolean;
}

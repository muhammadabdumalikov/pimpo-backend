import {OmitType} from '@nestjs/swagger';
import {CreateReceiptDto} from './create-receipt.dto';

/**
 * Edit a receipt. The payload fully replaces the document — its header fields
 * and every line.
 *
 * Only a DRAFT can be edited. A received receipt is final: its goods are on
 * the shelf and its cost is blended into the products, so rewriting the
 * document would move real inventory behind what reads like a document change.
 * A mistake on a received receipt is corrected by a supplier return, or by
 * deleting the receipt outright (DELETE, which takes its own explicit consent
 * and refuses once anything has been sold, paid or returned).
 *
 * `draft` is not accepted either: editing never changes a receipt's status,
 * and POST /receipts/:id/receive is what applies a draft to stock.
 */
export class UpdateReceiptDto extends OmitType(CreateReceiptDto, [
  'draft',
] as const) {}

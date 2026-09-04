import {OmitType} from '@nestjs/swagger';
import {CreateReceiptDto} from './create-receipt.dto';

/**
 * Edit a draft receipt. The payload fully replaces the document — its header
 * fields and every line. `draft` is not accepted: an edit always leaves the
 * receipt a draft, and POST /receipts/:id/receive applies it to stock.
 */
export class UpdateReceiptDto extends OmitType(CreateReceiptDto, [
  'draft',
] as const) {}

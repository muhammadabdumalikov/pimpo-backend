import {AppException} from './errors/app.exception';
import {ErrorCode} from './errors/error-codes';

// Why goods left stock or came back — one fixed list per flow, stored as a
// varchar code next to the free-text note. Fixed (not per-business) so the
// "Qaytarish va yo'qotishlar" report means the same thing in every shop and
// every locale; `other` carries the specifics in the note. A null code is a
// row written before codes existed, or by a client that sends none — the
// report shows it as "unspecified". See YOQOTISHLAR.md.
//
// CONTRACT: codes are permanent (the frontend localizes them) — add, never
// rename.

/** Hisobdan chiqarish (write-off). */
export const WRITE_OFF_REASONS = [
  'damaged',
  'expired',
  'lost',
  'theft',
  'internal_use',
  'other',
] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

/**
 * Moving sellable goods into the yaroqsiz tovarlar ombori — the write-off
 * codes that describe the goods' state (labels shared with write-offs).
 */
export const DEFECTIVE_IN_REASONS = ['damaged', 'expired', 'other'] as const;
export type DefectiveInReason = (typeof DEFECTIVE_IN_REASONS)[number];

/** Ta'minotchiga qaytarish (supplier return against a goods receipt). */
export const SUPPLIER_RETURN_REASONS = [
  'defective',
  'expired',
  'wrong_item',
  'excess',
  'unsold',
  'other',
] as const;
export type SupplierReturnReason = (typeof SUPPLIER_RETURN_REASONS)[number];

/** Mijozdan qaytarish (customer return of a sale). */
export const SALE_RETURN_REASONS = [
  'defective',
  'changed_mind',
  'wrong_item',
  'expired',
  'other',
] as const;
export type SaleReturnReason = (typeof SALE_RETURN_REASONS)[number];

/**
 * `other` says nothing on its own, so it must come with a note. Throws
 * REASON_NOTE_REQUIRED when it doesn't; every other code (and no code) passes.
 */
export function assertReasonNote(
  code: string | null | undefined,
  note: string | null | undefined,
): void {
  if (code === 'other' && !note?.trim()) {
    throw new AppException(ErrorCode.REASON_NOTE_REQUIRED);
  }
}

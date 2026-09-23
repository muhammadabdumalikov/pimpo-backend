import {and, isNull, ne, sql, type SQL} from 'drizzle-orm';
import {financialCategories, financialTransactions} from '../database/schema';

// Who wrote a ledger row (financial_transactions.source).
export type FinanceSource =
  | 'manual' // typed in Moliya (kirim / xarajat / ko'chirish)
  | 'external' // capital leg of a "Tashqi mablag'" pair
  | 'supplier_payment'
  | 'payroll'
  | 'shift_close'
  | 'cash_movement'
  | 'stock_take'
  | 'reversal'; // storno row

// Only these can be stornoed from Moliya; the rest belong to their module.
export const CANCELLABLE_SOURCES: readonly FinanceSource[] = [
  'manual',
  'external',
];

/**
 * A row that still counts: neither stornoed nor a storno itself. The pair is
 * left in the ledger for the audit trail, and together it nets to nothing.
 */
export function liveRow(): SQL {
  return and(
    isNull(financialTransactions.cancelledAt),
    ne(financialTransactions.source, 'reversal'),
  )!;
}

/**
 * Capital money — between the owner and the business, never profit or cost.
 * Needs `financial_categories` LEFT JOINed on category_id. Uncategorised
 * income typed by hand or at the till predates the capital flag; it is read
 * as capital so an old owner injection can't pass for profit.
 */
export function capitalRow(): SQL {
  return sql`(COALESCE(${financialCategories.isCapital}, false) OR (${financialTransactions.kind} = 'income' AND ${financialTransactions.categoryId} IS NULL AND ${financialTransactions.source} IN ('manual', 'cash_movement')))`;
}

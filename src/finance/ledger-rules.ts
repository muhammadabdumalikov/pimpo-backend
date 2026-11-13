import {and, isNull, ne, sql, type SQL} from 'drizzle-orm';
import {financialCategories, financialTransactions} from '../database/schema';

// Who wrote a ledger row (financial_transactions.source).
export type FinanceSource =
  | 'manual' // typed in Moliya (kirim / xarajat / ko'chirish)
  | 'external' // capital leg of a "Tashqi mablag'" pair
  | 'supplier_payment'
  // Cash a supplier handed back for defective goods (YOQOTISHLAR.md S17):
  // goods turned back into money — neither profit nor cost.
  | 'supplier_refund'
  | 'payroll'
  | 'shift_close'
  | 'cash_movement'
  | 'stock_take'
  // Value of undocumented opening stock (FILIAL-ASSORTIMENT.md Q4): capital,
  // not cash — goods the owner brought into the business.
  | 'opening_stock'
  // Online seller (ONLAYN-SOTUVCHI.md Q5, Q7): money taken on an online order
  // (deposit or balance) and deposits given back. Not P&L — the sale is the
  // revenue, read from orders on the day it completes.
  | 'order_payment'
  | 'order_refund'
  // The income leg of a deposit the shop kept on cancel: other income in P&L.
  | 'order_deposit_kept'
  | 'reversal'; // storno row

/** Ledger sources the P&L never reads as income or expense of their own. */
export const NON_PNL_SOURCES: readonly FinanceSource[] = [
  'supplier_payment',
  'supplier_refund',
  'order_payment',
  'order_refund',
];

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

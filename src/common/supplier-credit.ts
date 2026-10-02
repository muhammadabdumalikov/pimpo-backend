import {and, eq, inArray, sql} from 'drizzle-orm';
import {supplierCredits, suppliers} from '../database/schema';
import {DatabaseService} from '../database/database.service';
import {generateId} from '../utils/uuid';

// The transaction handle db.transaction hands its callback — same as costing.ts.
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];
type Db = DatabaseService['db'];

// A supplier's credit with us (YOQOTISHLAR.md S15–S16): what a defective
// return left them owing, spent later as a payment source on their receipts.
// A ledger, not a balance column — the balance per currency is the sum — so
// every movement keeps its reason. Shared by the defective-stock module (credit
// returns and their undoing) and the receipt module (paying from credit), so
// neither depends on the other.

export type SupplierCreditKind =
  | 'return'
  | 'return_cancel'
  | 'payment'
  | 'payment_cancel'
  // Till money handed to the supplier beyond what their receipts owed (0088).
  | 'advance'
  // An advance moved to / from another supplier (related_supplier_*).
  | 'transfer_out'
  | 'transfer_in';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Lock the supplier row: every credit write takes it first, so two spends of
 * the same credit queue instead of both reading the old balance.
 */
export async function lockSupplierTx(
  tx: Tx,
  businessId: string,
  supplierId: string,
): Promise<{id: string; name: string} | null> {
  const [row] = await tx
    .select({id: suppliers.id, name: suppliers.name})
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)))
    .for('update')
    .limit(1);
  return row ?? null;
}

/** The supplier's credit in one currency. Call after lockSupplierTx. */
export async function creditBalanceTx(
  tx: Tx | Db,
  businessId: string,
  supplierId: string,
  currency: string,
): Promise<number> {
  const [row] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${supplierCredits.amount}), 0)`,
    })
    .from(supplierCredits)
    .where(
      and(
        eq(supplierCredits.businessId, businessId),
        eq(supplierCredits.supplierId, supplierId),
        eq(supplierCredits.currency, currency),
      ),
    );
  return round2(Number(row?.total ?? 0));
}

/** supplierId → non-zero balances per currency. */
export async function creditBalances(
  db: Tx | Db,
  businessId: string,
  supplierIds?: string[],
): Promise<Map<string, {currency: string; amount: number}[]>> {
  const rows = await db
    .select({
      supplierId: supplierCredits.supplierId,
      currency: supplierCredits.currency,
      total: sql<string>`SUM(${supplierCredits.amount})`,
    })
    .from(supplierCredits)
    .where(
      and(
        eq(supplierCredits.businessId, businessId),
        ...(supplierIds
          ? [
              supplierIds.length
                ? inArray(supplierCredits.supplierId, supplierIds)
                : sql`false`,
            ]
          : []),
      ),
    )
    .groupBy(supplierCredits.supplierId, supplierCredits.currency)
    .orderBy(supplierCredits.currency);
  const out = new Map<string, {currency: string; amount: number}[]>();
  for (const r of rows) {
    const amount = round2(Number(r.total));
    if (Math.abs(amount) < 0.005) continue;
    const list = out.get(r.supplierId) ?? [];
    list.push({currency: r.currency, amount});
    out.set(r.supplierId, list);
  }
  return out;
}

/** One ledger row; `amount` is signed (+ credit gained, − credit spent). */
export async function addCreditTx(
  tx: Tx,
  row: {
    businessId: string;
    supplierId: string;
    currency: string;
    amount: number;
    kind: SupplierCreditKind;
    supplierReturnId?: string | null;
    supplierPaymentId?: string | null;
    receiptId?: string | null;
    /** The other side of a transfer_in / transfer_out. */
    relatedSupplierId?: string | null;
    relatedSupplierName?: string | null;
    note?: string | null;
    cashierId?: string | null;
    cashierName?: string | null;
  },
): Promise<void> {
  await tx.insert(supplierCredits).values({
    id: generateId(),
    businessId: row.businessId,
    supplierId: row.supplierId,
    currency: row.currency,
    amount: round2(row.amount).toFixed(2),
    kind: row.kind,
    supplierReturnId: row.supplierReturnId ?? null,
    supplierPaymentId: row.supplierPaymentId ?? null,
    receiptId: row.receiptId ?? null,
    relatedSupplierId: row.relatedSupplierId ?? null,
    relatedSupplierName: row.relatedSupplierName ?? null,
    note: row.note ?? null,
    cashierId: row.cashierId ?? null,
    cashierName: row.cashierName ?? null,
  });
}

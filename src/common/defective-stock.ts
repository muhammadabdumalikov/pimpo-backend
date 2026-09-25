import {and, asc, eq, gt, sql} from 'drizzle-orm';
import {
  defectiveLots,
  defectiveMovementItems,
  defectiveMovements,
} from '../database/schema';
import {DatabaseService} from '../database/database.service';
import {generateId} from '../utils/uuid';
import {AppException} from './errors/app.exception';
import {ErrorCode} from './errors/error-codes';

// The transaction handle db.transaction hands its callback — same as costing.ts.
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

// Yaroqsiz tovarlar ombori — the lot + document writes every flow shares: the
// till's defective customer return (order module) and the defective-stock
// module's own moves. Kept here, not in a service, so the order module doesn't
// depend on the defective-stock module.

export const DEFECTIVE_MOVEMENT_TYPES = [
  'in_return',
  'in_shelf',
  'in_opening',
  'out_supplier',
  'out_exchange',
  'out_writeoff',
  'out_to_sale',
] as const;
export type DefectiveMovementType = (typeof DEFECTIVE_MOVEMENT_TYPES)[number];

/** Where a lot's goods came from; an opening lot was a loss before it arrived. */
export type DefectiveLotSource = 'customer_return' | 'shelf' | 'opening';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const money = (n: number) => n.toFixed(2);

export interface DefectiveMovementLine {
  productId: string | null;
  productName: string;
  quantity: number;
  unitCost: number;
  costTotal: number;
  lossValue?: number;
  reasonCode?: string | null;
  note?: string | null;
}

/** Write one movement document and its lines; returns the movement id. */
export async function insertDefectiveMovementTx(
  tx: Tx,
  header: {
    id?: string;
    businessId: string;
    branchId: string;
    type: DefectiveMovementType;
    reasonCode?: string | null;
    note?: string | null;
    saleReturnId?: string | null;
    receiptId?: string | null;
    supplierReturnId?: string | null;
    supplierId?: string | null;
    supplierName?: string | null;
    creditValue?: number | null;
    currency?: string | null;
    cashierId: string | null;
    cashierName: string | null;
  },
  lines: DefectiveMovementLine[],
  itemCount: number,
): Promise<string> {
  const id = header.id ?? generateId();
  await tx.insert(defectiveMovements).values({
    id,
    businessId: header.businessId,
    branchId: header.branchId,
    type: header.type,
    reasonCode: header.reasonCode ?? null,
    note: header.note ?? null,
    saleReturnId: header.saleReturnId ?? null,
    receiptId: header.receiptId ?? null,
    supplierReturnId: header.supplierReturnId ?? null,
    supplierId: header.supplierId ?? null,
    supplierName: header.supplierName ?? null,
    itemCount,
    totalCost: money(round2(lines.reduce((s, l) => s + l.costTotal, 0))),
    lossValue: money(round2(lines.reduce((s, l) => s + (l.lossValue ?? 0), 0))),
    creditValue:
      header.creditValue === undefined || header.creditValue === null
        ? null
        : money(header.creditValue),
    currency: header.currency ?? null,
    cashierId: header.cashierId,
    cashierName: header.cashierName,
  });
  if (lines.length) {
    await tx.insert(defectiveMovementItems).values(
      lines.map((l) => ({
        id: generateId(),
        movementId: id,
        businessId: header.businessId,
        productId: l.productId,
        productName: l.productName,
        quantity: round3(l.quantity),
        unitCost: money(l.unitCost),
        costTotal: money(l.costTotal),
        lossValue: money(l.lossValue ?? 0),
        reasonCode: l.reasonCode ?? null,
        note: l.note ?? null,
      })),
    );
  }
  return id;
}

/** Put `qty` units into defective stock as one lot at `unitCost` (base UZS). */
export async function addDefectiveLotTx(
  tx: Tx,
  lot: {
    businessId: string;
    productId: string;
    branchId: string;
    qty: number;
    unitCost: number;
    source: DefectiveLotSource;
    movementId: string;
  },
): Promise<void> {
  await tx.insert(defectiveLots).values({
    id: generateId(),
    businessId: lot.businessId,
    productId: lot.productId,
    branchId: lot.branchId,
    unitCost: money(lot.unitCost),
    qtyIn: round3(lot.qty),
    qtyRemaining: round3(lot.qty),
    source: lot.source,
    movementId: lot.movementId,
  });
}

/**
 * Take `qty` units of a product out of a branch's defective stock, oldest lot
 * first. Lots are locked, and checked only after the lock, so two moves can't
 * both take the last unit. Returns the cost that left (base UZS) and the part
 * of it not yet booked as a loss (everything except opening lots) — what a
 * write-off must expense.
 */
export async function consumeDefectiveLotsTx(
  tx: Tx,
  p: {
    businessId: string;
    productId: string;
    branchId: string;
    qty: number;
    productName: string;
  },
): Promise<{costTotal: number; lossValue: number; unitCost: number}> {
  const lots = await tx
    .select()
    .from(defectiveLots)
    .where(
      and(
        eq(defectiveLots.businessId, p.businessId),
        eq(defectiveLots.productId, p.productId),
        eq(defectiveLots.branchId, p.branchId),
        gt(defectiveLots.qtyRemaining, 0),
      ),
    )
    .orderBy(asc(defectiveLots.createdAt))
    .for('update');
  const available = round3(lots.reduce((s, l) => s + l.qtyRemaining, 0));
  if (p.qty > available + 1e-9) {
    throw new AppException(ErrorCode.DEFECTIVE_EXCEEDS_STOCK, {
      qty: p.qty,
      name: p.productName,
      available,
    });
  }
  let left = p.qty;
  let costTotal = 0;
  let lossValue = 0;
  for (const lot of lots) {
    if (left <= 1e-9) break;
    const take = Math.min(left, lot.qtyRemaining);
    const cost = take * Number(lot.unitCost);
    costTotal += cost;
    if (lot.source !== 'opening') lossValue += cost;
    left -= take;
    await tx
      .update(defectiveLots)
      .set({
        qtyRemaining: sql`ROUND((${defectiveLots.qtyRemaining} - ${take})::numeric, 3)`,
      })
      .where(eq(defectiveLots.id, lot.id));
  }
  costTotal = round2(costTotal);
  return {
    costTotal,
    lossValue: round2(lossValue),
    unitCost: p.qty > 0 ? round2(costTotal / p.qty) : 0,
  };
}

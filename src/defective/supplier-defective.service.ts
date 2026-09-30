import {Injectable} from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  branches,
  defectiveLots,
  defectiveMovementItems,
  defectiveMovements,
  goodsReceiptItems,
  goodsReceipts,
  products,
  suppliers,
} from '../database/schema';
import {businessDayEnd, businessDayStart} from '../common/business-time';
import {productOfSupplier} from './supplier-attribution';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** One product × branch of a supplier's defective stock ("Omborda"). */
export interface SupplierDefectiveRow {
  productId: string;
  productName: string;
  code: string | null;
  barcode: string | null;
  quantityType: string | null;
  branchId: string;
  branchName: string | null;
  qty: number;
  /** At cost (base UZS). */
  value: number;
  /** When the oldest unit still here came in. */
  since: string;
  sources: string[];
  /** The product's default supplier is this one. */
  assigned: boolean;
  /** This supplier has delivered the product on a received receipt. */
  received: boolean;
  /** Other active suppliers the product also belongs to. */
  otherSuppliers: {id: string; name: string}[];
  /** This supplier's receipts that list the product and still carry debt. */
  openReceipts: number;
  /** What those receipts' debt can take back now (see returnable()). */
  returnableQty: number;
  /** returnableQty at the receipt lines' prices, in base UZS. */
  returnableValue: number;
}

export interface SupplierDefectiveTotals {
  /** Distinct products. */
  products: number;
  /** Units; a weighed product counts as one (same rule as the store page). */
  qty: number;
  /** At cost (base UZS). */
  value: number;
  /** Products with anything returnable now. */
  returnableProducts: number;
  /** At receipt prices (base UZS), capped by debt. */
  returnableValue: number;
}

interface LotRow {
  productId: string;
  productName: string;
  code: string | null;
  barcode: string | null;
  quantityType: string | null;
  assignedSupplierId: string | null;
  branchId: string;
  branchName: string | null;
  qty: number;
  value: number;
  since: string;
  sources: string[];
}

interface OpenReceipt {
  supplierId: string;
  /** Receipt currency → base UZS. */
  rate: number;
  /** Still owed, in the receipt currency. */
  outstanding: number;
}

interface OpenLines {
  receipts: Map<string, OpenReceipt>;
  /** `${receiptId}:${productId}` → unit price in the receipt currency. */
  price: Map<string, number>;
  /** `${supplierId}:${productId}` → open receipt ids, newest first. */
  bySupplierProduct: Map<string, string[]>;
}

/** Who a product belongs to: supplierId → how. Active suppliers only. */
type Owners = Map<
  string,
  Map<string, {name: string; assigned: boolean; received: boolean}>
>;

/**
 * Defective stock seen from the supplier side: the "Yaroqsiz" column and filter
 * on the suppliers list, and the "Yaroqsiz" tab on a supplier's page
 * (YOQOTISHLAR.md S1–S13).
 *
 * Attribution is per product (supplier-attribution.ts). What can go back now is
 * worked out the way a return would go: against this supplier's receipts that
 * list the product and still carry debt, newest first, each up to what is
 * still owed on it — the same receipt the return drawer suggests first.
 *
 * Read-only. Visible to anyone who can see suppliers when `defective_store` is
 * on; acting on it goes through /defective-stock (defective:manage).
 */
@Injectable()
export class SupplierDefectiveService {
  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  /** Per supplier with any defective stock: the suppliers list column. */
  async summary(
    businessId: string,
  ): Promise<{items: (SupplierDefectiveTotals & {supplierId: string})[]}> {
    const lots = await this.lots(businessId, {});
    if (!lots.length) return {items: []};
    const productIds = [...new Set(lots.map((l) => l.productId))];
    const owners = await this.owners(businessId, lots);
    const supplierIds = new Set<string>();
    for (const bySupplier of owners.values()) {
      for (const id of bySupplier.keys()) supplierIds.add(id);
    }
    const open = await this.openLines(businessId, productIds, [...supplierIds]);

    const items: (SupplierDefectiveTotals & {supplierId: string})[] = [];
    for (const supplierId of supplierIds) {
      const rows = lots.filter((l) => owners.get(l.productId)?.has(supplierId));
      if (!rows.length) continue;
      const {totals} = this.returnable(supplierId, rows, open);
      items.push({supplierId, ...totals});
    }
    items.sort((a, b) => b.value - a.value);
    return {items};
  }

  /** One supplier's defective stock, product × branch ("Omborda"). */
  async forSupplier(
    businessId: string,
    supplierId: string,
    q: {branchId?: string} = {},
  ): Promise<{items: SupplierDefectiveRow[]; totals: SupplierDefectiveTotals}> {
    const lots = await this.lots(businessId, {
      supplierId,
      branchId: q.branchId,
    });
    const productIds = [...new Set(lots.map((l) => l.productId))];
    const [owners, open] = await Promise.all([
      this.owners(businessId, lots),
      this.openLines(businessId, productIds, [supplierId]),
    ]);
    const {perRow, totals} = this.returnable(supplierId, lots, open);

    const items = lots.map((l, i): SupplierDefectiveRow => {
      const bySupplier = owners.get(l.productId);
      const mine = bySupplier?.get(supplierId);
      return {
        productId: l.productId,
        productName: l.productName,
        code: l.code,
        barcode: l.barcode,
        quantityType: l.quantityType,
        branchId: l.branchId,
        branchName: l.branchName,
        qty: l.qty,
        value: l.value,
        since: l.since,
        sources: l.sources,
        assigned: mine?.assigned ?? l.assignedSupplierId === supplierId,
        received: mine?.received ?? false,
        otherSuppliers: [...(bySupplier?.entries() ?? [])]
          .filter(([id]) => id !== supplierId)
          .map(([id, s]) => ({id, name: s.name}))
          .sort((a, b) => a.name.localeCompare(b.name)),
        ...perRow[i],
      };
    });
    return {items, totals};
  }

  /**
   * What has gone back to this supplier out of defective stock ("Qaytarilgan"):
   * returns off a receipt's debt, and exchanges recorded against them. An
   * exchange entered without a supplier belongs to nobody and is not here.
   */
  async history(
    businessId: string,
    supplierId: string,
    q: {
      branchId?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Math.max(1, q.page || 1);
    const limit = Math.min(Math.max(1, q.limit || 20), 100);
    const where: SQL[] = [
      eq(defectiveMovements.businessId, businessId),
      eq(defectiveMovements.supplierId, supplierId),
      inArray(defectiveMovements.type, ['out_supplier', 'out_exchange']),
    ];
    if (q.branchId) where.push(eq(defectiveMovements.branchId, q.branchId));
    if (q.from) {
      where.push(gte(defectiveMovements.createdAt, businessDayStart(q.from)));
    }
    if (q.to) {
      where.push(lte(defectiveMovements.createdAt, businessDayEnd(q.to)));
    }

    // A return's credit is in its receipt's currency; the rate it was booked
    // at turns it into so'm so a USD supplier's figures add up.
    const toUzs = sql`(case when ${defectiveMovements.currency} = 'USD' then coalesce(${goodsReceipts.usdRate}, 1) else 1 end)`;

    const [agg] = await this.db
      .select({
        movements: count(),
        returns: sql<number>`count(*) filter (where ${defectiveMovements.type} = 'out_supplier')::int`,
        returnedValue: sql<number>`coalesce(sum(${defectiveMovements.creditValue} * ${toUzs}) filter (where ${defectiveMovements.type} = 'out_supplier'), 0)::float8`,
        exchanges: sql<number>`count(*) filter (where ${defectiveMovements.type} = 'out_exchange')::int`,
        exchangedValue: sql<number>`coalesce(sum(${defectiveMovements.totalCost}) filter (where ${defectiveMovements.type} = 'out_exchange'), 0)::float8`,
      })
      .from(defectiveMovements)
      .leftJoin(goodsReceipts, eq(goodsReceipts.id, defectiveMovements.receiptId))
      .where(and(...where));

    const rows = await this.db
      .select({
        m: defectiveMovements,
        branchName: branches.name,
        receiptDate: goodsReceipts.createdAt,
        usdRate: goodsReceipts.usdRate,
      })
      .from(defectiveMovements)
      .leftJoin(branches, eq(branches.id, defectiveMovements.branchId))
      .leftJoin(goodsReceipts, eq(goodsReceipts.id, defectiveMovements.receiptId))
      .where(and(...where))
      .orderBy(desc(defectiveMovements.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    const lines = rows.length
      ? await this.db
          .select({
            movementId: defectiveMovementItems.movementId,
            productId: defectiveMovementItems.productId,
            productName: defectiveMovementItems.productName,
            quantity: defectiveMovementItems.quantity,
            unitCost: defectiveMovementItems.unitCost,
            costTotal: defectiveMovementItems.costTotal,
            reasonCode: defectiveMovementItems.reasonCode,
          })
          .from(defectiveMovementItems)
          .where(
            inArray(
              defectiveMovementItems.movementId,
              rows.map((r) => r.m.id),
            ),
          )
      : [];
    const quantityTypes = await this.quantityTypes(
      businessId,
      lines.map((l) => l.productId).filter((id): id is string => !!id),
    );
    const byMovement = new Map<string, typeof lines>();
    for (const l of lines) {
      const list = byMovement.get(l.movementId) ?? [];
      list.push(l);
      byMovement.set(l.movementId, list);
    }

    return {
      movements: rows.map((r) => {
        const credit =
          r.m.creditValue === null ? null : Number(r.m.creditValue);
        const rate =
          r.m.currency === 'USD' ? Number(r.usdRate ?? 1) || 1 : 1;
        return {
          id: r.m.id,
          type: r.m.type as 'out_supplier' | 'out_exchange',
          createdAt: r.m.createdAt,
          branchId: r.m.branchId,
          branchName: r.branchName,
          receiptId: r.m.receiptId,
          receiptDate: r.receiptDate,
          /** Taken off the receipt's debt, in the receipt currency (returns only). */
          creditValue: credit,
          currency: r.m.currency,
          /** creditValue in base UZS (returns only). */
          creditValueUzs: credit === null ? null : round2(credit * rate),
          /** Cost of the goods that left (base UZS). */
          totalCost: Number(r.m.totalCost),
          itemCount: r.m.itemCount,
          reasonCode: r.m.reasonCode,
          note: r.m.note,
          cashierName: r.m.cashierName,
          items: (byMovement.get(r.m.id) ?? []).map((l) => ({
            productId: l.productId,
            productName: l.productName,
            quantityType: l.productId
              ? (quantityTypes.get(l.productId) ?? null)
              : null,
            quantity: l.quantity,
            unitCost: Number(l.unitCost),
            costTotal: Number(l.costTotal),
            reasonCode: l.reasonCode,
          })),
        };
      }),
      total: Number(agg?.movements ?? 0),
      page,
      limit,
      totals: {
        returns: agg?.returns ?? 0,
        returnedValue: round2(agg?.returnedValue ?? 0),
        exchanges: agg?.exchanges ?? 0,
        exchangedValue: round2(agg?.exchangedValue ?? 0),
      },
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** Defective stock on hand, per product × branch, largest value first. */
  private async lots(
    businessId: string,
    q: {branchId?: string; supplierId?: string},
  ): Promise<LotRow[]> {
    const where: SQL[] = [
      eq(defectiveLots.businessId, businessId),
      gt(defectiveLots.qtyRemaining, 0),
    ];
    if (q.branchId) where.push(eq(defectiveLots.branchId, q.branchId));
    if (q.supplierId) {
      where.push(
        productOfSupplier(defectiveLots.productId, businessId, q.supplierId),
      );
    }
    const value = sql`SUM(${defectiveLots.qtyRemaining} * ${defectiveLots.unitCost})`;
    const rows = await this.db
      .select({
        productId: defectiveLots.productId,
        productName: products.name,
        code: products.code,
        barcode: products.barcode,
        quantityType: products.quantityType,
        assignedSupplierId: products.supplierId,
        branchId: defectiveLots.branchId,
        branchName: branches.name,
        qty: sql<string>`SUM(${defectiveLots.qtyRemaining})`,
        value: sql<string>`SUM(${defectiveLots.qtyRemaining} * ${defectiveLots.unitCost})`,
        since: sql<string>`MIN(${defectiveLots.createdAt})`,
        sources: sql<string[]>`array_agg(DISTINCT ${defectiveLots.source})`,
      })
      .from(defectiveLots)
      .innerJoin(products, eq(products.id, defectiveLots.productId))
      .leftJoin(branches, eq(branches.id, defectiveLots.branchId))
      .where(and(...where))
      .groupBy(
        defectiveLots.productId,
        products.name,
        products.code,
        products.barcode,
        products.quantityType,
        products.supplierId,
        defectiveLots.branchId,
        branches.name,
      )
      .orderBy(desc(value));
    return rows.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      code: r.code,
      barcode: r.barcode,
      quantityType: r.quantityType,
      assignedSupplierId: r.assignedSupplierId,
      branchId: r.branchId,
      branchName: r.branchName,
      qty: round3(Number(r.qty)),
      value: round2(Number(r.value)),
      since: toIso(r.since),
      sources: r.sources ?? [],
    }));
  }

  /** Every active supplier each product belongs to, and how. */
  private async owners(businessId: string, lots: LotRow[]): Promise<Owners> {
    const productIds = [...new Set(lots.map((l) => l.productId))];
    if (!productIds.length) return new Map();
    const received = await this.db
      .selectDistinct({
        productId: goodsReceiptItems.productId,
        supplierId: goodsReceipts.supplierId,
      })
      .from(goodsReceiptItems)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.receiptId))
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ne(goodsReceipts.status, 'draft'),
          isNotNull(goodsReceipts.supplierId),
          inArray(goodsReceiptItems.productId, productIds),
        ),
      );

    const links: {productId: string; supplierId: string; how: 'a' | 'r'}[] =
      [];
    for (const l of lots) {
      if (l.assignedSupplierId) {
        links.push({
          productId: l.productId,
          supplierId: l.assignedSupplierId,
          how: 'a',
        });
      }
    }
    for (const r of received) {
      if (r.productId && r.supplierId) {
        links.push({productId: r.productId, supplierId: r.supplierId, how: 'r'});
      }
    }
    const supplierIds = [...new Set(links.map((l) => l.supplierId))];
    // A deleted (inactive) supplier drops out: nothing can be returned to it
    // and it has no row on the list.
    const active = supplierIds.length
      ? await this.db
          .select({id: suppliers.id, name: suppliers.name})
          .from(suppliers)
          .where(
            and(
              eq(suppliers.businessId, businessId),
              eq(suppliers.isActive, true),
              inArray(suppliers.id, supplierIds),
            ),
          )
      : [];
    const nameOf = new Map(active.map((s) => [s.id, s.name]));

    const owners: Owners = new Map();
    for (const link of links) {
      const name = nameOf.get(link.supplierId);
      if (name === undefined) continue;
      const bySupplier = owners.get(link.productId) ?? new Map();
      const entry = bySupplier.get(link.supplierId) ?? {
        name,
        assigned: false,
        received: false,
      };
      if (link.how === 'a') entry.assigned = true;
      else entry.received = true;
      bySupplier.set(link.supplierId, entry);
      owners.set(link.productId, bySupplier);
    }
    return owners;
  }

  /** These suppliers' receipts that list these products and still carry debt. */
  private async openLines(
    businessId: string,
    productIds: string[],
    supplierIds: string[],
  ): Promise<OpenLines> {
    const open: OpenLines = {
      receipts: new Map(),
      price: new Map(),
      bySupplierProduct: new Map(),
    };
    if (!productIds.length || !supplierIds.length) return open;
    const rows = await this.db
      .select({
        receiptId: goodsReceipts.id,
        supplierId: goodsReceipts.supplierId,
        currency: goodsReceipts.currency,
        usdRate: goodsReceipts.usdRate,
        totalAmount: goodsReceipts.totalAmount,
        paidAmount: goodsReceipts.paidAmount,
        returnedAmount: goodsReceipts.returnedAmount,
        productId: goodsReceiptItems.productId,
        priceIn: goodsReceiptItems.priceIn,
      })
      .from(goodsReceiptItems)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.receiptId))
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ne(goodsReceipts.status, 'draft'),
          inArray(goodsReceipts.supplierId, supplierIds),
          inArray(goodsReceiptItems.productId, productIds),
          // Same test as the return drawer's candidates.
          sql`${goodsReceipts.totalAmount} - ${goodsReceipts.paidAmount} - ${goodsReceipts.returnedAmount} > 0.004`,
        ),
      )
      .orderBy(
        desc(goodsReceipts.createdAt),
        desc(goodsReceiptItems.createdAt),
      );

    for (const r of rows) {
      if (!r.productId || !r.supplierId) continue;
      if (!open.receipts.has(r.receiptId)) {
        open.receipts.set(r.receiptId, {
          supplierId: r.supplierId,
          rate: r.currency === 'USD' ? Number(r.usdRate ?? 1) || 1 : 1,
          outstanding:
            Number(r.totalAmount) -
            Number(r.paidAmount) -
            Number(r.returnedAmount),
        });
      }
      // A receipt listing the product twice: the newest line's price wins,
      // as in the return itself.
      const key = `${r.receiptId}:${r.productId}`;
      if (open.price.has(key)) continue;
      open.price.set(key, Number(r.priceIn));
      const sp = `${r.supplierId}:${r.productId}`;
      const list = open.bySupplierProduct.get(sp) ?? [];
      list.push(r.receiptId);
      open.bySupplierProduct.set(sp, list);
    }
    return open;
  }

  /**
   * How much of each row this supplier's open receipts can take back now.
   *
   * Rows go largest value first; each takes from the product's receipts newest
   * first, each receipt up to its remaining debt, which the rows share — two
   * products on one receipt cannot both spend the same debt. A unit product
   * goes back whole, so the quantity rounds down; a weighed one to the gram.
   */
  private returnable(
    supplierId: string,
    rows: LotRow[],
    open: OpenLines,
  ): {
    perRow: {openReceipts: number; returnableQty: number; returnableValue: number}[];
    totals: SupplierDefectiveTotals;
  } {
    const debtLeft = new Map<string, number>();
    for (const [id, r] of open.receipts) {
      if (r.supplierId === supplierId) debtLeft.set(id, r.outstanding);
    }
    const perRow = rows.map((row) => {
      const receiptIds =
        open.bySupplierProduct.get(`${supplierId}:${row.productId}`) ?? [];
      const weighed = row.quantityType === 'kg';
      let left = row.qty;
      let qty = 0;
      let value = 0;
      for (const receiptId of receiptIds) {
        if (left <= 0) break;
        const debt = debtLeft.get(receiptId) ?? 0;
        if (debt <= 0.004) continue;
        const price = open.price.get(`${receiptId}:${row.productId}`) ?? 0;
        const fits = price > 0 ? Math.min(left, debt / price) : left;
        const take = weighed
          ? Math.floor(fits * 1000 + 1e-6) / 1000
          : Math.floor(fits + 1e-9);
        if (take <= 0) continue;
        debtLeft.set(receiptId, debt - take * price);
        left = round3(left - take);
        qty += take;
        value += take * price * (open.receipts.get(receiptId)?.rate ?? 1);
      }
      return {
        openReceipts: receiptIds.length,
        returnableQty: round3(qty),
        returnableValue: round2(value),
      };
    });

    const totals: SupplierDefectiveTotals = {
      products: new Set(rows.map((r) => r.productId)).size,
      qty: round3(
        rows.reduce((s, r) => s + (r.quantityType === 'kg' ? 1 : r.qty), 0),
      ),
      value: round2(rows.reduce((s, r) => s + r.value, 0)),
      returnableProducts: new Set(
        rows.filter((_, i) => perRow[i].returnableQty > 0).map((r) => r.productId),
      ).size,
      returnableValue: round2(perRow.reduce((s, r) => s + r.returnableValue, 0)),
    };
    return {perRow, totals};
  }

  private async quantityTypes(businessId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = unique.length
      ? await this.db
          .select({id: products.id, quantityType: products.quantityType})
          .from(products)
          .where(
            and(eq(products.businessId, businessId), inArray(products.id, unique)),
          )
      : [];
    return new Map(rows.map((r) => [r.id, r.quantityType]));
  }
}

function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  // timestamp without time zone comes back as UTC wall-time text.
  return new Date(`${v.replace(' ', 'T')}Z`).toISOString();
}

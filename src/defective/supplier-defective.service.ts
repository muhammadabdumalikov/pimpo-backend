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
import {
  offReceiptPrices,
  priceInReceiptCurrency,
  productOfSupplier,
  type OffReceiptPrice,
} from './supplier-attribution';

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
  /**
   * This supplier's receipts that still carry debt and can take the product:
   * those listing it, plus (S14) their other open receipts when the product
   * has a price to go back at. 0 = "Ochiq qarzli nakladnoy yo'q".
   */
  openReceipts: number;
  /** How many of those list the product; 0 with openReceipts > 0 = off another receipt's debt. */
  openReceiptsListing: number;
  /** What those receipts' debt can take back now (see returnable()). */
  returnableQty: number;
  /** returnableQty at the prices it would go back at, in base UZS. */
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
  currency: string;
  usdRate: string | null;
  /** Receipt currency → base UZS. */
  rate: number;
  /** Still owed, in the receipt currency. */
  outstanding: number;
}

interface OpenLines {
  receipts: Map<string, OpenReceipt>;
  /** supplierId → every open receipt of theirs, newest first. */
  bySupplier: Map<string, string[]>;
  /** `${receiptId}:${productId}` → unit price in the receipt currency. */
  price: Map<string, number>;
  /** `${supplierId}:${productId}` → open receipts listing it, newest first. */
  bySupplierProduct: Map<string, string[]>;
  /** `${supplierId}:${productId}` → price off a receipt that doesn't list it (S14). */
  offPrice: Map<string, OffReceiptPrice>;
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
 * still carry debt — those listing the product first, at their line price,
 * then (S14) their other open receipts at the off-receipt price — each up to
 * what is still owed on it, in the order the return drawer suggests them.
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

  /**
   * These suppliers' receipts that still carry debt, the lines on them for
   * these products, and each product's off-receipt price per supplier.
   */
  private async openLines(
    businessId: string,
    productIds: string[],
    supplierIds: string[],
  ): Promise<OpenLines> {
    const open: OpenLines = {
      receipts: new Map(),
      bySupplier: new Map(),
      price: new Map(),
      bySupplierProduct: new Map(),
      offPrice: new Map(),
    };
    if (!productIds.length || !supplierIds.length) return open;
    const receipts = await this.db
      .select({
        id: goodsReceipts.id,
        supplierId: goodsReceipts.supplierId,
        currency: goodsReceipts.currency,
        usdRate: goodsReceipts.usdRate,
        totalAmount: goodsReceipts.totalAmount,
        paidAmount: goodsReceipts.paidAmount,
        returnedAmount: goodsReceipts.returnedAmount,
      })
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ne(goodsReceipts.status, 'draft'),
          inArray(goodsReceipts.supplierId, supplierIds),
          // Same test as the return drawer's candidates.
          sql`${goodsReceipts.totalAmount} - ${goodsReceipts.paidAmount} - ${goodsReceipts.returnedAmount} > 0.004`,
        ),
      )
      .orderBy(desc(goodsReceipts.createdAt));
    for (const r of receipts) {
      if (!r.supplierId) continue;
      open.receipts.set(r.id, {
        supplierId: r.supplierId,
        currency: r.currency,
        usdRate: r.usdRate,
        rate: r.currency === 'USD' ? Number(r.usdRate ?? 1) || 1 : 1,
        outstanding:
          Number(r.totalAmount) - Number(r.paidAmount) - Number(r.returnedAmount),
      });
      const list = open.bySupplier.get(r.supplierId) ?? [];
      list.push(r.id);
      open.bySupplier.set(r.supplierId, list);
    }
    if (!open.receipts.size) return open;

    const [lines, offPrice] = await Promise.all([
      this.db
        .select({
          receiptId: goodsReceiptItems.receiptId,
          productId: goodsReceiptItems.productId,
          priceIn: goodsReceiptItems.priceIn,
        })
        .from(goodsReceiptItems)
        .where(
          and(
            inArray(goodsReceiptItems.receiptId, [...open.receipts.keys()]),
            inArray(goodsReceiptItems.productId, productIds),
          ),
        )
        .orderBy(desc(goodsReceiptItems.createdAt)),
      offReceiptPrices(this.db, businessId, supplierIds, productIds),
    ]);
    open.offPrice = offPrice;
    for (const l of lines) {
      if (!l.productId) continue;
      // A receipt listing the product twice: the newest line's price wins,
      // as in the return itself.
      const key = `${l.receiptId}:${l.productId}`;
      if (open.price.has(key)) continue;
      open.price.set(key, Number(l.priceIn));
    }
    // Newest receipt first, as the candidates list orders them.
    for (const [supplierId, ids] of open.bySupplier) {
      for (const receiptId of ids) {
        for (const productId of productIds) {
          if (!open.price.has(`${receiptId}:${productId}`)) continue;
          const sp = `${supplierId}:${productId}`;
          const list = open.bySupplierProduct.get(sp) ?? [];
          list.push(receiptId);
          open.bySupplierProduct.set(sp, list);
        }
      }
    }
    return open;
  }

  /**
   * How much of each row this supplier's open receipts can take back now.
   *
   * Two passes over the rows, largest value first. The first spends the
   * receipts that list the product (newest first, at their line price); the
   * second what is left on the supplier's other open receipts (S14, at the
   * off-receipt price). Each receipt gives up to its remaining debt, which
   * the rows share — two products cannot both spend the same debt — and a
   * product's own receipts are never crowded out by another's off-receipt
   * share. A unit product goes back whole, so the quantity rounds down; a
   * weighed one to the gram.
   */
  private returnable(
    supplierId: string,
    rows: LotRow[],
    open: OpenLines,
  ): {
    perRow: {
      openReceipts: number;
      openReceiptsListing: number;
      returnableQty: number;
      returnableValue: number;
    }[];
    totals: SupplierDefectiveTotals;
  } {
    const debtLeft = new Map<string, number>();
    for (const [id, r] of open.receipts) {
      if (r.supplierId === supplierId) debtLeft.set(id, r.outstanding);
    }
    const all = open.bySupplier.get(supplierId) ?? [];
    const plan = rows.map((row) => {
      const listing =
        open.bySupplierProduct.get(`${supplierId}:${row.productId}`) ?? [];
      const listed = new Set(listing);
      const ref = open.offPrice.get(`${supplierId}:${row.productId}`);
      const others = ref ? all.filter((id) => !listed.has(id)) : [];
      return {row, listing, others, ref, left: row.qty, qty: 0, value: 0};
    });

    const take = (
      p: (typeof plan)[number],
      receiptId: string,
      price: number,
    ) => {
      if (p.left <= 0) return;
      const debt = debtLeft.get(receiptId) ?? 0;
      if (debt <= 0.004) return;
      const fits = price > 0 ? Math.min(p.left, debt / price) : p.left;
      const n =
        p.row.quantityType === 'kg'
          ? Math.floor(fits * 1000 + 1e-6) / 1000
          : Math.floor(fits + 1e-9);
      if (n <= 0) return;
      debtLeft.set(receiptId, debt - n * price);
      p.left = round3(p.left - n);
      p.qty += n;
      p.value += n * price * (open.receipts.get(receiptId)?.rate ?? 1);
    };

    for (const p of plan) {
      for (const receiptId of p.listing) {
        take(p, receiptId, open.price.get(`${receiptId}:${p.row.productId}`) ?? 0);
      }
    }
    for (const p of plan) {
      if (!p.ref) continue;
      for (const receiptId of p.others) {
        const r = open.receipts.get(receiptId);
        if (!r) continue;
        take(p, receiptId, priceInReceiptCurrency(p.ref, r));
      }
    }

    const perRow = plan.map((p) => ({
      openReceipts: p.listing.length + p.others.length,
      openReceiptsListing: p.listing.length,
      returnableQty: round3(p.qty),
      returnableValue: round2(p.value),
    }));

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

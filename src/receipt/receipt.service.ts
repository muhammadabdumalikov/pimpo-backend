import {Injectable, Inject} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {isStockTakeActive} from '../common/stock-take-lock';
import {businessDayStart, businessDayEnd} from '../common/business-time';
import {DatabaseService} from '../database/database.service';
import {
  goodsReceipts,
  goodsReceiptItems,
  inventoryBatches,
  products,
  branchStock,
  suppliers,
  receiptSettings,
  supplierPayments,
  supplierReturns,
  supplierReturnItems,
  staff,
  businesses,
  branches,
  type GoodsReceipt,
  type GoodsReceiptItem,
  type SupplierPayment,
  type SupplierReturn,
} from '../database/schema';
import {
  eq,
  and,
  asc,
  desc,
  gt,
  gte,
  ilike,
  lte,
  ne,
  or,
  inArray,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {FinanceService} from '../finance/finance.service';
import {BranchService} from '../branch/branch.service';
import {CreateReceiptDto} from './dto/create-receipt.dto';
import {UpdateReceiptDto} from './dto/update-receipt.dto';
import {UpdateReceiptHeaderDto} from './dto/update-receipt-header.dto';
import {AddPaymentDto} from './dto/add-payment.dto';
import {CreateReturnDto} from './dto/create-return.dto';
import {displayAmount} from '../common/display-amount';
import {recordPriceChangesTx} from '../common/price-history';

function money(value: number): string {
  return value.toFixed(2);
}

/**
 * Roll what is settled against the total into a status. Settled is what was
 * paid PLUS what was returned — goods sent back reduce the debt as surely as
 * money does, so every caller passes both. Compared in whole cents: USD lines
 * sum in floating point, and 99.99999 must still read as paid.
 */
function paymentStatusOf(settled: number, total: number): string {
  const settledCents = Math.round(settled * 100);
  if (settledCents <= 0) return 'unpaid';
  if (settledCents >= Math.round(total * 100)) return 'paid';
  return 'partial';
}

/** What is still owed on a receipt, never below zero, to the cent. */
function outstandingOf(receipt: GoodsReceipt): number {
  const cents =
    Math.round(Number(receipt.totalAmount) * 100) -
    Math.round(Number(receipt.paidAmount) * 100) -
    Math.round(Number(receipt.returnedAmount) * 100);
  return Math.max(0, cents) / 100;
}

export type ReceiptWithItems = GoodsReceipt & {
  branchName?: string | null;
  items: GoodsReceiptItem[];
  payments?: SupplierPayment[];
  returns?: SupplierReturn[];
};

// A prepared receipt line, ready to apply to stock (batches + costing).
interface ReceiptLine {
  itemId: string;
  productId: string;
  productName: string;
  // priceIn is in the receipt currency; priceInBase is the same in UZS (the
  // base used for inventory batches + weighted-average cost).
  priceIn: string;
  priceInBase: string;
  currency: string;
  priceOut: string;
  priceWholesale: string | null;
  priceBundle: string | null;
  quantity: number;
  lineTotal: string;
}

// Everything a receipt payload turns into: the lines to store plus the
// per-product aggregates that applying it to stock needs.
interface PreparedReceipt {
  supplierName: string | null;
  currency: 'UZS' | 'USD';
  rateToBase: number;
  lines: ReceiptLine[];
  received: Map<string, {qty: number; value: number}>;
  productInfo: Map<
    string,
    {name: string; priceOut: string; quantityType?: string | null}
  >;
  total: number;
  itemCount: number;
}

// Drizzle transaction handle (parameter of db.transaction's callback).
type DbTx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** The card fields a receipt line can propose a new figure for. */
export type PriceField = 'priceOut' | 'priceWholesale' | 'priceBundle';

/** One product whose card prices disagree with what this receipt says. */
export interface PriceSuggestion {
  productId: string;
  productName: string;
  current: {
    priceOut: string | null;
    priceWholesale: string | null;
    priceBundle: string | null;
  };
  proposed: {
    priceOut: string | null;
    priceWholesale: string | null;
    priceBundle: string | null;
  };
  /** Which of the three actually differ — the rest are left alone. */
  changes: PriceField[];
}

@Injectable()
export class ReceiptService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly financeService: FinanceService,
    private readonly branchService: BranchService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // Acting cashier (owner or staff) — snapshotted onto the payment.
  private async resolveCashier(
    account?: IAccount,
  ): Promise<{id: string | null; name: string | null}> {
    if (!account) return {id: null, name: null};
    if (account.type === 'staff') {
      const [row] = await this.dbService.db
        .select({name: staff.name})
        .from(staff)
        .where(eq(staff.id, account.id))
        .limit(1);
      return {id: account.id, name: row?.name ?? null};
    }
    const [row] = await this.dbService.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, account.id))
      .limit(1);
    return {id: account.id, name: row?.name ?? null};
  }

  /**
   * Turn a receipt payload into the lines to store plus the aggregates needed
   * to apply it to stock. Validates the supplier, the currency/rate pair and
   * every product. Shared by creating a receipt and by editing a draft.
   */
  private async prepareReceipt(
    businessId: string,
    dto: CreateReceiptDto,
  ): Promise<PreparedReceipt> {
    // Resolve supplier (optional) and snapshot its name.
    let supplierName: string | null = null;
    if (dto.supplierId) {
      const [supplier] = await this.dbService.db
        .select()
        .from(suppliers)
        .where(
          and(
            eq(suppliers.businessId, businessId),
            eq(suppliers.id, dto.supplierId),
          ),
        )
        .limit(1);
      if (!supplier) {
        throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND_BY_ID, {
          supplierId: dto.supplierId,
        });
      }
      supplierName = supplier.name;
    }

    // Supply currency + the USD→UZS rate used to convert cost to base for
    // inventory. USD receipts settle in USD (debt/payments) but stock cost is
    // always stored in base UZS.
    const currency = dto.currency ?? 'UZS';
    if (currency === 'USD' && (!dto.usdRate || dto.usdRate <= 0)) {
      throw new AppException(ErrorCode.RECEIPT_USD_RATE_REQUIRED);
    }
    const rateToBase = currency === 'USD' ? Number(dto.usdRate) : 1;

    // Validate + snapshot each product once (products may repeat across lines).
    // The receipt keeps every entered line as the document of record.
    const productInfo = new Map<
      string,
      {name: string; priceOut: string; quantityType?: string | null}
    >();
    // Per-product received totals — the same product across multiple lines is
    // summed so a single stock/cost update applies the full received batch
    // (otherwise a second line for the same product would overwrite the first).
    const received = new Map<string, {qty: number; value: number}>();
    const lines: ReceiptLine[] = [];
    let total = 0;
    let itemCount = 0;

    for (const item of dto.items) {
      let info = productInfo.get(item.productId);
      if (info === undefined) {
        const [product] = await this.dbService.db
          .select()
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, item.productId),
            ),
          )
          .limit(1);
        if (!product) {
          throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
            productId: item.productId,
          });
        }
        info = {
          name: product.name,
          priceOut: product.priceOut,
          quantityType: product.quantityType,
        };
        productInfo.set(item.productId, info);
      }
      // Selling price of this batch: explicit, else the product's current price.
      const priceOut = item.priceOut ?? Number(info.priceOut);
      const priceWholesale =
        item.priceWholesale != null ? money(item.priceWholesale) : null;
      const priceBundle =
        item.priceBundle != null ? money(item.priceBundle) : null;
      // Line total is in the receipt currency; the base cost (UZS) drives the
      // inventory batch + weighted-average product cost.
      const lineTotal = item.priceIn * item.quantity;
      const priceInBase = item.priceIn * rateToBase;
      total += lineTotal;
      // Weighed goods count as one item so itemCount stays whole (integer col).
      itemCount += info.quantityType === 'kg' ? 1 : item.quantity;

      lines.push({
        itemId: generateId(),
        productId: item.productId,
        productName: info.name,
        priceIn: money(item.priceIn),
        priceInBase: money(priceInBase),
        currency,
        priceOut: money(priceOut),
        priceWholesale,
        priceBundle,
        quantity: item.quantity,
        lineTotal: money(lineTotal),
      });

      const agg = received.get(item.productId) ?? {qty: 0, value: 0};
      agg.qty += item.quantity;
      agg.value += priceInBase * item.quantity;
      received.set(item.productId, agg);
    }

    return {
      supplierName,
      currency,
      rateToBase,
      lines,
      received,
      productInfo,
      total,
      itemCount,
    };
  }

  /**
   * Every line must carry a real quantity before the goods go on the shelf.
   *
   * A DRAFT is allowed to hold a line at zero: it is a document being typed,
   * and a row whose amount has not been reached yet must survive being saved —
   * dropping it is how a delivery quietly loses a product (the card is already
   * in the catalogue, so what is left is stock that never arrives). Receiving
   * is the other end of that: a zero line would open an empty lot and post
   * nothing, so it is named and refused instead.
   */
  private assertLinesQuantified(
    lines: {productName: string; quantity: number}[],
  ): void {
    const blank = lines.find((l) => !(l.quantity > 0));
    if (blank) {
      throw new AppException(ErrorCode.RECEIPT_LINE_QUANTITY_REQUIRED, {
        name: blank.productName,
      });
    }
  }

  /**
   * Create a goods receipt: insert the document + items, increment product
   * stock, and roll each product's purchase cost into a weighted average — all
   * in one transaction. A received receipt is immutable; a draft can still be
   * edited or deleted until it is received.
   */
  async create(
    businessId: string,
    dto: CreateReceiptDto,
  ): Promise<ReceiptWithItems> {
    // Freeze inbound stock while a count is open — a receipt changes
    // products.quantity and opens a new batch, which would desync the count's
    // book snapshot and break the SUM(qtyRemaining)==quantity invariant when the
    // count snaps stock back to the counted figure. Same freeze sales/shifts use
    // (INVENTARIZATSIYA.md §9.4); guarded + fail-open if the table isn't migrated.
    if (await isStockTakeActive(this.cache, this.dbService.db, businessId)) {
      throw new AppException(ErrorCode.RECEIPT_FROZEN_STOCK_TAKE);
    }

    const {
      supplierName,
      currency,
      rateToBase,
      lines,
      received,
      productInfo,
      total,
      itemCount,
    } = await this.prepareReceipt(businessId, dto);

    const receiptId = generateId();
    const draft = dto.draft === true;
    if (!draft) this.assertLinesQuantified(lines);

    // Attribute the receipt to a branch ("do'kon"); fall back to the default.
    const branchId =
      dto.branchId ?? (await this.branchService.ensureDefault(businessId)).id;

    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(goodsReceipts).values({
        id: receiptId,
        businessId,
        supplierId: dto.supplierId ?? null,
        supplierName,
        branchId,
        status: draft ? 'draft' : 'received',
        totalAmount: money(total),
        currency,
        usdRate: currency === 'USD' ? money(rateToBase) : null,
        itemCount,
        note: dto.note ?? null,
      });

      await tx.insert(goodsReceiptItems).values(
        lines.map((line) => ({
          id: line.itemId,
          receiptId,
          businessId,
          productId: line.productId,
          productName: line.productName,
          priceIn: line.priceIn,
          currency: line.currency,
          priceOut: line.priceOut,
          priceWholesale: line.priceWholesale,
          priceBundle: line.priceBundle,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
        })),
      );

      // A draft only records the document — stock, batches and cost are applied
      // later when it is received. A normal receipt applies them immediately.
      if (!draft) {
        await this.applyReceiptStockTx(tx, businessId, branchId, lines, received);
      }
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Apply a receipt's lines to stock: open one inventory
   * batch per line, add received quantity + roll the weighted-average cost, and
   * settle the selling price (reprice existing batches or track the FIFO front).
   * Runs inside the caller's transaction. Shared by immediate receipts and by
   * receiving a draft.
   */
  private async applyReceiptStockTx(
    tx: DbTx,
    businessId: string,
    branchId: string,
    lines: ReceiptLine[],
    received: Map<string, {qty: number; value: number}>,
  ): Promise<void> {
    // No selling price is touched here, in either direction. The prices typed
    // on a delivery note are what that document says; the prices the shop
    // charges live on the product cards. A delivery proposes and a person
    // disposes — see getPriceSuggestions / applyPrices. Receiving used to write
    // both: it pushed the entered tiers onto the cards and re-pointed the card
    // price at a lot, so a 20%-markup figure nobody had looked at could become
    // the shelf price of a whole catalogue.

    // Open one inventory batch per line — the FIFO/cost source of truth. Same
    // product at different prices stays as separate lots. The batch belongs to
    // the receipt's branch so per-branch FIFO draws from the right store.
    await tx.insert(inventoryBatches).values(
      lines.map((line) => ({
        id: generateId(),
        businessId,
        productId: line.productId,
        branchId,
        receiptItemId: line.itemId,
        // Batches hold cost in base UZS (converted from the receipt currency).
        priceIn: line.priceInBase,
        priceOut: line.priceOut,
        qtyReceived: line.quantity,
        qtyRemaining: line.quantity,
      })),
    );

    // Add the received quantity to the receipt's BRANCH stock (upsert the row).
    for (const [productId, agg] of received) {
      await tx
        .insert(branchStock)
        .values({
          id: generateId(),
          businessId,
          productId,
          branchId,
          quantity: agg.qty,
        })
        .onConflictDoUpdate({
          target: [branchStock.productId, branchStock.branchId],
          set: {
            quantity: sql`ROUND((${branchStock.quantity} + ${agg.qty})::numeric, 3)`,
            updatedAt: new Date(),
          },
        });
    }

    // One atomic update per product: add the received quantity and roll the
    // purchase cost into a weighted average, computed in SQL against the live
    // row so concurrent sales/receipts can't clobber the result.
    for (const [productId, agg] of received) {
      await tx
        .update(products)
        .set({
          quantity: sql`ROUND((${products.quantity} + ${agg.qty})::numeric, 3)`,
          priceIn: sql`CASE WHEN ${products.quantity} + ${agg.qty} > 0
              THEN ROUND(
                ((${products.quantity} * ${products.priceIn} + ${money(agg.value)})
                / (${products.quantity} + ${agg.qty}))::numeric,
                2
              )
              ELSE ${products.priceIn} END`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(products.businessId, businessId), eq(products.id, productId)),
        );
    }

  }

  /**
   * Receive a draft receipt: apply its stored lines to stock/cost and flip the
   * status to 'received'. Rebuilds the apply inputs from the saved items.
   */
  async receiveReceipt(
    businessId: string,
    receiptId: string,
  ): Promise<ReceiptWithItems> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    if (receipt.status !== 'draft') {
      throw new AppException(ErrorCode.RECEIPT_ONLY_DRAFT_RECEIVABLE);
    }

    const items = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));

    // Cost is stored in base UZS; convert the saved line prices by the receipt's
    // rate (1 for UZS receipts).
    const rateToBase =
      receipt.currency === 'USD' ? Number(receipt.usdRate ?? 0) : 1;

    // Rebuild the apply inputs from the saved lines + the products' live prices.
    const lines: ReceiptLine[] = [];
    const received = new Map<string, {qty: number; value: number}>();
    const productInfo = new Map<string, {name: string; priceOut: string}>();

    for (const it of items) {
      if (!it.productId) continue;
      let info = productInfo.get(it.productId);
      if (!info) {
        const [product] = await this.dbService.db
          .select({priceOut: products.priceOut})
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, it.productId),
            ),
          )
          .limit(1);
        info = {
          name: it.productName,
          priceOut: product?.priceOut ?? it.priceOut ?? '0',
        };
        productInfo.set(it.productId, info);
      }
      const priceOut = it.priceOut ?? info.priceOut;
      const priceInBase = Number(it.priceIn) * rateToBase;
      lines.push({
        itemId: it.id,
        productId: it.productId,
        productName: it.productName,
        priceIn: it.priceIn,
        priceInBase: money(priceInBase),
        currency: it.currency ?? 'UZS',
        priceOut,
        priceWholesale: it.priceWholesale,
        priceBundle: it.priceBundle,
        quantity: it.quantity,
        lineTotal: it.lineTotal,
      });
      const agg = received.get(it.productId) ?? {qty: 0, value: 0};
      agg.qty += it.quantity;
      agg.value += priceInBase * it.quantity;
      received.set(it.productId, agg);
    }

    this.assertLinesQuantified(lines);

    const receiveBranchId =
      receipt.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;
    await this.dbService.db.transaction(async (tx) => {
      await this.applyReceiptStockTx(
        tx,
        businessId,
        receiveBranchId,
        lines,
        received,
      );
      await tx
        .update(goodsReceipts)
        .set({status: 'received', updatedAt: new Date()})
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Take a received order back to draft.
   *
   * The exact reverse of `receiveReceipt`: the batches it opened are dropped,
   * branch stock and products.quantity come back down and cost is recomputed
   * from the lots that remain — but the document stays, as a draft, so its
   * lines can be corrected and it can be received again. This is what a shop
   * wants when a nakladnoy was received wrong: the paperwork is right, the
   * numbers on it are not.
   *
   * The lines are not touched at all. Quantities, the supplier's cost, the
   * selling prices entered on the delivery, the currency — the draft opens on
   * exactly the nakladnoy that was received, which is the point: what is
   * corrected is usually one number on it, and everything typed around that
   * number should still be there.
   *
   * Held to the same line `loadReversible` draws for deleting, and for the
   * same reason: every unit this document brought in must still be on the
   * shelf, and it must carry no payments or returns. Once a unit is sold or
   * moved to another branch, its cost came out of this receipt's batch and
   * unwinding the batch would rewrite a closed record — that correction is a
   * supplier return, not an un-receive.
   */
  async unreceiveReceipt(
    businessId: string,
    receiptId: string,
  ): Promise<ReceiptWithItems> {
    // Taking goods off the shelf under an open count desyncs the count's book
    // snapshot exactly the way receiving into it does (INVENTARIZATSIYA.md
    // §9.4).
    if (await isStockTakeActive(this.cache, this.dbService.db, businessId)) {
      throw new AppException(ErrorCode.RECEIPT_FROZEN_STOCK_TAKE);
    }

    const {receipt, items} = await this.loadReversible(businessId, receiptId);
    if (receipt.status === 'draft') {
      throw new AppException(ErrorCode.RECEIPT_ALREADY_DRAFT);
    }

    await this.dbService.db.transaction(async (tx) => {
      // `loadReversible` read outside this transaction, so everything it
      // cleared is re-checked here under lock. Without it two presses of the
      // button — two tabs, two devices, a retried request — would both pass
      // that check and each subtract the receipt's quantity, taking twice the
      // stock off the shelf.
      const locked = await this.lockReceiptTx(tx, businessId, receiptId);
      if (locked.status === 'draft') {
        throw new AppException(ErrorCode.RECEIPT_ALREADY_DRAFT);
      }
      await this.assertLotsWholeTx(tx, businessId, items);
      // The locked row, not the one read before it: a branch change committed
      // in between would otherwise take the stock off the wrong branch.
      await this.reverseReceiptStockTx(tx, businessId, locked, items);
      await tx
        .update(goodsReceipts)
        .set({status: 'draft', updatedAt: new Date()})
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Take the receipt's row for this transaction, and hand back what it says
   * now. Anything that reverses stock reads the document first and acts on it
   * second; between those two the document can move. Holding the row makes
   * the second reader wait for the first to commit, and then see the truth.
   */
  private async lockReceiptTx(
    tx: DbTx,
    businessId: string,
    receiptId: string,
  ): Promise<GoodsReceipt> {
    const [locked] = await tx
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .for('update')
      .limit(1);
    // Gone while we waited — someone else deleted it.
    if (!locked) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    return locked;
  }

  /**
   * The `loadReversible` "nothing of it has left the shelf" check again, now
   * inside the transaction and with the lots locked.
   *
   * A sale takes the same lots FOR UPDATE, so this either runs before it (and
   * the sale then waits for us) or after it (and sees what it took). Read
   * outside a transaction, the check could pass a hair before a sale drew on
   * the lot, and dropping the lot afterwards would subtract that sale's units
   * a second time and leave a closed sale costed against a batch that no
   * longer exists.
   */
  private async assertLotsWholeTx(
    tx: DbTx,
    businessId: string,
    items: GoodsReceiptItem[],
  ): Promise<void> {
    const itemIds = items.map((i) => i.id);
    if (!itemIds.length) return;

    const batches = await tx
      .select({
        receiptItemId: inventoryBatches.receiptItemId,
        qtyReceived: inventoryBatches.qtyReceived,
        qtyRemaining: inventoryBatches.qtyRemaining,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          inArray(inventoryBatches.receiptItemId, itemIds),
        ),
      )
      .for('update');

    const consumed = batches.find(
      (b) => b.qtyReceived - b.qtyRemaining > 0.0005,
    );
    if (consumed) {
      const item = items.find((i) => i.id === consumed.receiptItemId);
      throw new AppException(ErrorCode.RECEIPT_PARTLY_SOLD, {
        name: item?.productName ?? '',
        sold:
          Math.round((consumed.qtyReceived - consumed.qtyRemaining) * 1000) /
          1000,
      });
    }
  }

  /**
   * Load a receipt that may still be taken back whole.
   *
   * A draft qualifies trivially — it holds nothing. A received one qualifies
   * only while every unit it brought in is still on the shelf: the moment a
   * sale consumes one, that sale's cost came out of this receipt's batch, and
   * unwinding the batch would rewrite a closed sale. That is the same line the
   * returns flow draws, and it is drawn here for the same reason.
   *
   * Payments and returns block it too. Both are records of their own, made
   * against this document; deleting the document under them would leave money
   * and goods pointing at nothing.
   */
  private async loadReversible(
    businessId: string,
    receiptId: string,
  ): Promise<{receipt: GoodsReceipt; items: GoodsReceiptItem[]}> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);

    const items = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));

    if (receipt.status === 'draft') return {receipt, items};

    const [ret] = await this.dbService.db
      .select({id: supplierReturns.id})
      .from(supplierReturns)
      .where(
        and(
          eq(supplierReturns.businessId, businessId),
          eq(supplierReturns.receiptId, receiptId),
        ),
      )
      .limit(1);
    if (ret) throw new AppException(ErrorCode.RECEIPT_HAS_RETURNS);

    const [pay] = await this.dbService.db
      .select({id: supplierPayments.id})
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.businessId, businessId),
          eq(supplierPayments.receiptId, receiptId),
        ),
      )
      .limit(1);
    if (pay) throw new AppException(ErrorCode.RECEIPT_HAS_PAYMENTS);

    const itemIds = items.map((i) => i.id);
    if (itemIds.length) {
      const batches = await this.dbService.db
        .select({
          receiptItemId: inventoryBatches.receiptItemId,
          qtyReceived: inventoryBatches.qtyReceived,
          qtyRemaining: inventoryBatches.qtyRemaining,
        })
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.businessId, businessId),
            inArray(inventoryBatches.receiptItemId, itemIds),
          ),
        );
      // Fractions of a kilo are stored to the gram, so compare with the same
      // tolerance the rest of the stock maths uses rather than exactly.
      const consumed = batches.find(
        (b) => b.qtyReceived - b.qtyRemaining > 0.0005,
      );
      if (consumed) {
        const item = items.find((i) => i.id === consumed.receiptItemId);
        throw new AppException(ErrorCode.RECEIPT_PARTLY_SOLD, {
          name: item?.productName ?? '',
          sold:
            Math.round((consumed.qtyReceived - consumed.qtyRemaining) * 1000) /
            1000,
        });
      }
    }

    return {receipt, items};
  }

  /**
   * Undo what receiving this document did to stock and cost.
   *
   * Only ever called for a receipt `loadReversible` has cleared, so every
   * batch it opened is still whole and can simply be dropped. Cost is not
   * un-blended arithmetically — `products.priceIn` is a weighted average
   * across receipts and subtracting one term back out drifts — it is
   * RECOMPUTED from the batches that remain, which is exact by construction
   * and self-healing if anything was ever off.
   */
  private async reverseReceiptStockTx(
    tx: DbTx,
    businessId: string,
    receipt: GoodsReceipt,
    items: GoodsReceiptItem[],
  ): Promise<void> {
    const itemIds = items.map((i) => i.id);
    if (!itemIds.length) return;

    const perProduct = new Map<string, number>();
    for (const it of items) {
      if (!it.productId) continue;
      perProduct.set(
        it.productId,
        (perProduct.get(it.productId) ?? 0) + it.quantity,
      );
    }

    // Which branch each product's units are sitting in. The lot knows — it was
    // opened into a branch and follows the receipt when the header moves — and
    // the header does not always: a legacy receipt carries no branch at all,
    // and taking the quantity off the product while leaving branch_stock alone
    // would break the "branch rows sum to products.quantity" invariant.
    const branchOf = new Map<string, string>();
    for (const lot of await tx
      .select({
        productId: inventoryBatches.productId,
        branchId: inventoryBatches.branchId,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          inArray(inventoryBatches.receiptItemId, itemIds),
        ),
      )) {
      if (lot.branchId) branchOf.set(lot.productId, lot.branchId);
    }

    await tx
      .delete(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          inArray(inventoryBatches.receiptItemId, itemIds),
        ),
      );
    for (const [productId, qty] of perProduct) {
      const branchId = branchOf.get(productId) ?? receipt.branchId;
      if (branchId) {
        await tx
          .update(branchStock)
          .set({
            quantity: sql`GREATEST(ROUND((${branchStock.quantity} - ${qty})::numeric, 3), 0)`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(branchStock.businessId, businessId),
              eq(branchStock.productId, productId),
              eq(branchStock.branchId, branchId),
            ),
          );
      }

      // What this product still has in open lots, now that this receipt's are
      // gone: the quantity is the truth for stock, the value for cost.
      const [left] = await tx
        .select({
          qty: sql<string>`COALESCE(SUM(${inventoryBatches.qtyRemaining}), 0)`,
          value: sql<string>`COALESCE(SUM(${inventoryBatches.qtyRemaining} * ${inventoryBatches.priceIn}), 0)`,
        })
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.businessId, businessId),
            eq(inventoryBatches.productId, productId),
            gt(inventoryBatches.qtyRemaining, 0),
          ),
        );
      const leftQty = Number(left?.qty ?? 0);
      const leftValue = Number(left?.value ?? 0);

      await tx
        .update(products)
        .set({
          quantity: sql`GREATEST(ROUND((${products.quantity} - ${qty})::numeric, 3), 0)`,
          // With nothing left in lots there is no average to take — the last
          // cost known is better than zeroing a price the shop still quotes.
          ...(leftQty > 0
            ? {priceIn: money(leftValue / leftQty)}
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(eq(products.businessId, businessId), eq(products.id, productId)),
        );

      // The selling price is deliberately left alone. Cost is arithmetic — it
      // is whatever the remaining lots were bought for — but the price is a
      // decision the shop made, and undoing a delivery is no reason to undo it.
    }
  }

  /**
   * Edit a DRAFT receipt: the payload replaces its header and every line.
   *
   * A draft holds no stock, batches, payments or returns, so swapping its
   * lines needs no reversal — it stays a draft and is applied later by
   * receiving it.
   *
   * A RECEIVED receipt is never edited. Its goods are on the shelf and its
   * cost is already blended into the products, so rewriting the document would
   * move real inventory behind what reads like a document change — and a
   * client that merely retried a save (a stale tab, a mobile app, an
   * integration) would move it without anyone deciding to. A mistake on a
   * received receipt is corrected by a supplier return, or by deleting the
   * receipt outright, which asks for that consent explicitly.
   */
  async update(
    businessId: string,
    receiptId: string,
    dto: UpdateReceiptDto,
  ): Promise<ReceiptWithItems> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    if (receipt.status !== 'draft') {
      throw new AppException(ErrorCode.RECEIPT_ONLY_DRAFT_EDITABLE);
    }

    // Stock, cost and price tiers are not touched here — a draft applies none
    // of that until it is received — so only the document's own fields are
    // taken off the prepared payload.
    const {supplierName, currency, rateToBase, lines, total, itemCount} =
      await this.prepareReceipt(businessId, dto);

    // Keep the receipt on its current branch unless the edit moves it.
    const branchId =
      dto.branchId ??
      receipt.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;

    await this.dbService.db.transaction(async (tx) => {
      // A draft holds no batches and no stock — its lines are just swapped.
      await tx
        .delete(goodsReceiptItems)
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            eq(goodsReceiptItems.receiptId, receiptId),
          ),
        );

      await tx.insert(goodsReceiptItems).values(
        lines.map((line) => ({
          id: line.itemId,
          receiptId,
          businessId,
          productId: line.productId,
          productName: line.productName,
          priceIn: line.priceIn,
          currency: line.currency,
          priceOut: line.priceOut,
          priceWholesale: line.priceWholesale,
          priceBundle: line.priceBundle,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
        })),
      );

      await tx
        .update(goodsReceipts)
        .set({
          supplierId: dto.supplierId ?? null,
          supplierName,
          branchId,
          totalAmount: money(total),
          currency,
          usdRate: currency === 'USD' ? money(rateToBase) : null,
          itemCount,
          note: dto.note ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Fix a receipt's header — its supplier and its branch ("do'kon") — at any
   * point in its life, not just while it is a draft. Both are things a shop
   * commonly gets wrong on entry and only notices later.
   *
   * A draft holds nothing, so it is a plain relabel. A received receipt already
   * put stock somewhere: moving it to another branch moves what is LEFT of its
   * own lots along with it, while the part already sold stays booked to the
   * branch that sold it. The supplier is metadata, but this receipt's payments
   * and returns each carry a supplier snapshot of their own — they are
   * relabelled too, or the supplier ledger would split across two names.
   */
  async updateHeader(
    businessId: string,
    receiptId: string,
    dto: UpdateReceiptHeaderDto,
  ): Promise<ReceiptWithItems> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);

    // Supplier: undefined leaves it alone, null detaches it.
    const supplierGiven = dto.supplierId !== undefined;
    let supplierId = receipt.supplierId;
    let supplierName = receipt.supplierName;
    if (supplierGiven) {
      if (dto.supplierId) {
        const [supplier] = await this.dbService.db
          .select()
          .from(suppliers)
          .where(
            and(
              eq(suppliers.businessId, businessId),
              eq(suppliers.id, dto.supplierId),
            ),
          )
          .limit(1);
        if (!supplier) {
          throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND_BY_ID, {
            supplierId: dto.supplierId,
          });
        }
        supplierId = supplier.id;
        supplierName = supplier.name;
      } else {
        supplierId = null;
        supplierName = null;
      }
    }

    // Legacy rows can carry no branch; their stock went to the default one.
    const fromBranchId =
      receipt.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;
    let branchId = fromBranchId;
    if (dto.branchId !== undefined && dto.branchId !== fromBranchId) {
      const [branch] = await this.dbService.db
        .select()
        .from(branches)
        .where(
          and(
            eq(branches.businessId, businessId),
            eq(branches.id, dto.branchId),
          ),
        )
        .limit(1);
      if (!branch) throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
      branchId = branch.id;
    }

    // Only a received receipt holds stock to move.
    const movesStock = branchId !== fromBranchId && receipt.status !== 'draft';
    // Same freeze as receiving: an open count snapshots the book figure, and
    // shifting stock between branches underneath it would desync the count.
    if (
      movesStock &&
      (await isStockTakeActive(this.cache, this.dbService.db, businessId))
    ) {
      throw new AppException(ErrorCode.RECEIPT_FROZEN_STOCK_TAKE);
    }

    await this.dbService.db.transaction(async (tx) => {
      if (movesStock) {
        await this.moveReceiptStockTx(
          tx,
          businessId,
          receiptId,
          fromBranchId,
          branchId,
        );
      }

      await tx
        .update(goodsReceipts)
        .set({supplierId, supplierName, branchId, updatedAt: new Date()})
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );

      if (supplierGiven) {
        await tx
          .update(supplierPayments)
          .set({supplierId, supplierName})
          .where(
            and(
              eq(supplierPayments.businessId, businessId),
              eq(supplierPayments.receiptId, receiptId),
            ),
          );
        await tx
          .update(supplierReturns)
          .set({supplierId, supplierName})
          .where(
            and(
              eq(supplierReturns.businessId, businessId),
              eq(supplierReturns.receiptId, receiptId),
            ),
          );
      }
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Move a received receipt's own inventory lots from one branch to another,
   * along with the branch stock they back. products.quantity is the sum across
   * branches, so it does not change — only where the goods sit does.
   *
   * A lot nobody has touched moves whole. A partly sold lot is split: the sold
   * part stays at the old branch (that is where it was sold from) and the
   * remainder opens as a lot at the new branch, keeping the receipt link so a
   * later branch change finds it again. Splitting `qtyReceived` across the two
   * rows keeps the receipt's received total exact.
   */
  private async moveReceiptStockTx(
    tx: DbTx,
    businessId: string,
    receiptId: string,
    fromBranchId: string,
    toBranchId: string,
  ): Promise<void> {
    const itemIds = (
      await tx
        .select({id: goodsReceiptItems.id})
        .from(goodsReceiptItems)
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            eq(goodsReceiptItems.receiptId, receiptId),
          ),
        )
    ).map((r) => r.id);
    if (itemIds.length === 0) return;

    const lots = await tx
      .select({
        id: inventoryBatches.id,
        productId: inventoryBatches.productId,
        receiptItemId: inventoryBatches.receiptItemId,
        priceIn: inventoryBatches.priceIn,
        priceOut: inventoryBatches.priceOut,
        qtyReceived: inventoryBatches.qtyReceived,
        qtyRemaining: inventoryBatches.qtyRemaining,
        createdAt: inventoryBatches.createdAt,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          eq(inventoryBatches.branchId, fromBranchId),
          inArray(inventoryBatches.receiptItemId, itemIds),
        ),
      )
      .for('update');

    const moved = new Map<string, number>();
    const newLots: (typeof inventoryBatches.$inferInsert)[] = [];

    for (const lot of lots) {
      const qty = lot.qtyRemaining;
      // Sold out at the old branch — nothing left of this lot to move.
      if (qty <= 0) continue;
      moved.set(
        lot.productId,
        Math.round(((moved.get(lot.productId) ?? 0) + qty) * 1000) / 1000,
      );

      if (qty === lot.qtyReceived) {
        await tx
          .update(inventoryBatches)
          .set({branchId: toBranchId})
          .where(eq(inventoryBatches.id, lot.id));
        continue;
      }

      await tx
        .update(inventoryBatches)
        .set({
          qtyReceived: Math.round((lot.qtyReceived - qty) * 1000) / 1000,
          qtyRemaining: 0,
        })
        .where(eq(inventoryBatches.id, lot.id));
      newLots.push({
        id: generateId(),
        businessId,
        productId: lot.productId,
        branchId: toBranchId,
        receiptItemId: lot.receiptItemId,
        priceIn: lot.priceIn,
        priceOut: lot.priceOut,
        qtyReceived: qty,
        qtyRemaining: qty,
        createdAt: lot.createdAt,
      });
    }

    if (newLots.length > 0) await tx.insert(inventoryBatches).values(newLots);

    // Per-branch on-hand follows the lots. ROUND needs the ::numeric cast —
    // branch_stock.quantity is double precision.
    for (const [productId, qty] of moved) {
      await tx
        .update(branchStock)
        .set({
          quantity: sql`GREATEST(0, ROUND((${branchStock.quantity} - ${qty})::numeric, 3))`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(branchStock.businessId, businessId),
            eq(branchStock.productId, productId),
            eq(branchStock.branchId, fromBranchId),
          ),
        );
      await tx
        .insert(branchStock)
        .values({
          id: generateId(),
          businessId,
          productId,
          branchId: toBranchId,
          quantity: qty,
        })
        .onConflictDoUpdate({
          target: [branchStock.productId, branchStock.branchId],
          set: {
            quantity: sql`ROUND((${branchStock.quantity} + ${qty})::numeric, 3)`,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * Delete a draft receipt and its lines. Nothing else references a draft —
   * stock, batches, payments and returns only exist once it is received.
   */
  /**
   * Delete a receipt.
   *
   * A draft is just a document and goes quietly. A received one is taken off
   * stock first — its batches dropped, cost recomputed from what remains —
   * which is only allowed while none of it has been sold. Owner-only at the
   * controller, because this removes a document the books refer to.
   */
  async remove(
    businessId: string,
    receiptId: string,
    opts: {amendReceived?: boolean} = {},
  ): Promise<void> {
    const {receipt, items} = await this.loadReversible(businessId, receiptId);

    // Same consent as an edit, for the same reason: deleting a received
    // receipt takes its goods off the shelf.
    if (receipt.status !== 'draft' && opts.amendReceived !== true) {
      throw new AppException(ErrorCode.RECEIPT_ONLY_DRAFT_DELETABLE);
    }

    await this.dbService.db.transaction(async (tx) => {
      // Under lock, and on what the row says now — not on the copy read
      // before it. Two deletes, or a delete racing an un-receive, would
      // otherwise each reverse the same stock; a locked status of 'draft'
      // means someone already did, so this one only takes the document away.
      const locked = await this.lockReceiptTx(tx, businessId, receiptId);
      if (locked.status !== 'draft') {
        await this.assertLotsWholeTx(tx, businessId, items);
        await this.reverseReceiptStockTx(tx, businessId, locked, items);
      }
      await tx
        .delete(goodsReceiptItems)
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            eq(goodsReceiptItems.receiptId, receiptId),
          ),
        );
      await tx
        .delete(goodsReceipts)
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );
    });
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      supplierId?: string;
      branchId?: string;
      paymentStatus?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      /** Free text: supplier, note, document id, or a product on the receipt. */
      search?: string;
    },
  ): Promise<{
    receipts: Array<GoodsReceipt & {branchName: string | null}>;
    total: number;
    page: number;
    limit: number;
  }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;

    const whereConditions = [eq(goodsReceipts.businessId, businessId)];
    if (options?.supplierId) {
      whereConditions.push(eq(goodsReceipts.supplierId, options.supplierId));
    }
    if (options?.branchId) {
      whereConditions.push(eq(goodsReceipts.branchId, options.branchId));
    }
    if (options?.paymentStatus) {
      whereConditions.push(
        eq(goodsReceipts.paymentStatus, options.paymentStatus),
      );
    }
    if (options?.status === 'draft') {
      whereConditions.push(eq(goodsReceipts.status, 'draft'));
    } else if (options?.status === 'received') {
      // 'received' covers both new receipts and legacy 'Completed' rows.
      whereConditions.push(ne(goodsReceipts.status, 'draft'));
    }
    if (options?.startDate) {
      whereConditions.push(
        gte(goodsReceipts.createdAt, businessDayStart(options.startDate)),
      );
    }
    if (options?.endDate) {
      whereConditions.push(
        lte(goodsReceipts.createdAt, businessDayEnd(options.endDate)),
      );
    }

    // A goods receipt carries no document number, so people look for it by who
    // supplied it, by what is on it, or by the short id the list shows. The
    // product match is an EXISTS on the receipt's own lines (their name
    // snapshot, plus the catalogue's barcode) — that is how procurement asks
    // the question: "which delivery had this item?".
    const search = options?.search?.trim();
    if (search) {
      const like = `%${search}%`;
      whereConditions.push(
        or(
          ilike(goodsReceipts.supplierName, like),
          ilike(goodsReceipts.note, like),
          ilike(goodsReceipts.id, like),
          sql`exists (
            select 1 from ${goodsReceiptItems}
            left join ${products} on ${products.id} = ${goodsReceiptItems.productId}
            where ${goodsReceiptItems.receiptId} = ${goodsReceipts.id}
              and (${goodsReceiptItems.productName} ilike ${like}
                   or ${products.barcode} ilike ${like}
                   or ${products.code} ilike ${like})
          )`,
        )!,
      );
    }

    const [{value: total}] = await this.dbService.db
      .select({value: sql<number>`count(*)::int`})
      .from(goodsReceipts)
      .where(and(...whereConditions));

    const paginated = await this.dbService.db
      .select({...getTableColumns(goodsReceipts), branchName: branches.name})
      .from(goodsReceipts)
      .leftJoin(branches, eq(goodsReceipts.branchId, branches.id))
      .where(and(...whereConditions))
      .orderBy(desc(goodsReceipts.createdAt))
      .limit(limit)
      .offset(offset);

    return {receipts: paginated, total, page, limit};
  }

  async findOne(
    businessId: string,
    receiptId: string,
  ): Promise<ReceiptWithItems | null> {
    const [receipt] = await this.dbService.db
      .select({...getTableColumns(goodsReceipts), branchName: branches.name})
      .from(goodsReceipts)
      .leftJoin(branches, eq(goodsReceipts.branchId, branches.id))
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);

    if (!receipt) {
      return null;
    }

    const items = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));

    const payments = await this.getPayments(businessId, receiptId);
    const returns = await this.getReturns(businessId, receiptId);

    return {...receipt, items, payments, returns};
  }

  // ─── Supplier payments (T1) ───────────────────────────────────────────────

  /** Payment history for a receipt, newest first. */
  async getPayments(
    businessId: string,
    receiptId: string,
  ): Promise<SupplierPayment[]> {
    return this.dbService.db
      .select()
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.businessId, businessId),
          eq(supplierPayments.receiptId, receiptId),
        ),
      )
      .orderBy(desc(supplierPayments.createdAt));
  }

  /**
   * Record a payment to the supplier against a receipt: book a finance expense
   * (so the money-out hits the account balance and shows in Moliya), store the
   * payment row, and roll up the receipt's paidAmount/paymentStatus — all in one
   * transaction so the finance ledger and the receipt never drift apart.
   */
  async addPayment(
    businessId: string,
    receiptId: string,
    dto: AddPaymentDto,
    account?: IAccount,
  ): Promise<{payment: SupplierPayment; receipt: GoodsReceipt}> {
    const cashier = await this.resolveCashier(account);
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();

    return this.dbService.db.transaction(async (tx) => {
      // What is owed is read under the row lock and written back from the
      // same read. Read outside, two payments entered at once would each add
      // to the same starting figure and one would vanish from the receipt —
      // while both still left the account.
      const receipt = await this.lockReceiptTx(tx, businessId, receiptId);
      if (receipt.status === 'draft') {
        throw new AppException(ErrorCode.RECEIPT_RECEIVE_BEFORE_PAYMENT);
      }

      const currency = receipt.currency ?? 'UZS';
      const outstanding = outstandingOf(receipt);
      if (outstanding <= 0) {
        throw new AppException(ErrorCode.RECEIPT_ALREADY_SETTLED);
      }
      if (Math.round(dto.amount * 100) > Math.round(outstanding * 100)) {
        throw new AppException(ErrorCode.RECEIPT_PAYMENT_EXCEEDS_DEBT, {
          outstanding: displayAmount(outstanding),
          currency,
        });
      }

      const txn = await this.financeService.recordExpenseTx(tx, businessId, {
        source: 'supplier_payment',
        accountId: dto.accountId,
        external: dto.external,
        allowNegative: dto.allowNegative,
        amount: dto.amount,
        currency,
        note:
          dto.note ??
          `Ta'minotchi to'lovi${receipt.supplierName ? `: ${receipt.supplierName}` : ''}`,
        cashierId: cashier.id,
        cashierName: cashier.name,
      });

      const [payment] = await tx
        .insert(supplierPayments)
        .values({
          id: generateId(),
          businessId,
          receiptId,
          supplierId: receipt.supplierId,
          supplierName: receipt.supplierName,
          amount: money(dto.amount),
          currency,
          accountId: txn.accountId,
          accountName: txn.accountName,
          financialTransactionId: txn.id,
          note: dto.note ?? null,
          cashierId: cashier.id,
          cashierName: cashier.name,
          paidAt,
        })
        .returning();

      const newPaid = Number(receipt.paidAmount) + dto.amount;
      const [updated] = await tx
        .update(goodsReceipts)
        .set({
          paidAmount: money(newPaid),
          paymentStatus: paymentStatusOf(
            newPaid + Number(receipt.returnedAmount),
            Number(receipt.totalAmount),
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        )
        .returning();

      return {payment, receipt: updated};
    });
  }

  /**
   * Cancel a payment made against a receipt.
   *
   * The money comes back the way payroll reverses a paid wage: the finance
   * expense is not deleted but answered with a compensating income on the same
   * account, so Moliya keeps both rows — what left, and that it was taken
   * back. The payment record itself goes, and the receipt's paid figure and
   * status are rolled back from it.
   *
   * This is also what opens the way to un-receiving or deleting a receipt,
   * both of which refuse while any payment stands.
   */
  async cancelPayment(
    businessId: string,
    receiptId: string,
    paymentId: string,
    account?: IAccount,
  ): Promise<{receipt: GoodsReceipt}> {
    const cashier = await this.resolveCashier(account);

    return this.dbService.db.transaction(async (tx) => {
      // Receipt first, then the payment — the same order a payment is added
      // in, so a cancel and an add on one receipt queue instead of crossing.
      // A second cancel of the same payment waits here and then finds it gone.
      const receipt = await this.lockReceiptTx(tx, businessId, receiptId);
      const [payment] = await tx
        .select()
        .from(supplierPayments)
        .where(
          and(
            eq(supplierPayments.id, paymentId),
            eq(supplierPayments.businessId, businessId),
            eq(supplierPayments.receiptId, receiptId),
          ),
        )
        .for('update')
        .limit(1);
      if (!payment) {
        throw new AppException(ErrorCode.RECEIPT_PAYMENT_NOT_FOUND);
      }

      const amount = Number(payment.amount);
      // A payment with no booked expense behind it (none were made without
      // one, but the columns are nullable) has nothing in Moliya to answer.
      if (payment.financialTransactionId && payment.accountId) {
        await this.financeService.reverseTx(
          tx,
          businessId,
          payment.financialTransactionId,
          cashier,
        );
      }

      await tx
        .delete(supplierPayments)
        .where(eq(supplierPayments.id, payment.id));

      const newPaid = Math.max(
        0,
        Math.round((Number(receipt.paidAmount) - amount) * 100) / 100,
      );
      const [updated] = await tx
        .update(goodsReceipts)
        .set({
          paidAmount: money(newPaid),
          paymentStatus: paymentStatusOf(
            newPaid + Number(receipt.returnedAmount),
            Number(receipt.totalAmount),
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        )
        .returning();

      return {receipt: updated};
    });
  }

  // ─── Selling prices a receipt proposes ───────────────────────────────────

  /**
   * The lines of this receipt whose selling prices differ from what the product
   * cards say today — what receiving no longer applies on its own.
   *
   * A delivery note is where a price change is usually noticed: the goods came
   * in dearer, so the shelf price moves. It is not where that price is decided.
   * Receiving used to write these figures onto the cards by itself, and since a
   * blank line is pre-filled from the house markup, a document nobody read
   * could quietly reprice a shop's whole catalogue. So the receipt proposes and
   * a person disposes: this is the proposal.
   *
   * Same product on several lines: the last line that named a price wins, the
   * way the document reads.
   */
  async getPriceSuggestions(
    businessId: string,
    receiptId: string,
  ): Promise<PriceSuggestion[]> {
    const receipt = await this.findOne(businessId, receiptId);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    return this.buildPriceSuggestions(businessId, receipt);
  }

  /**
   * Put the receipt's prices on the chosen products' cards. Only the products
   * asked for, and only the fields that actually differ — a card nobody picked
   * keeps the price it has.
   */
  async applyPrices(
    businessId: string,
    receiptId: string,
    decision: {applyToCard?: string[]; applyToReceipt?: string[]},
    account?: IAccount,
  ): Promise<{
    applied: number;
    toCard: PriceSuggestion[];
    toReceipt: PriceSuggestion[];
  }> {
    const receipt = await this.findOne(businessId, receiptId);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    // A draft's prices are still being typed and its goods are not on the shelf.
    if (receipt.status === 'draft') {
      throw new AppException(ErrorCode.RECEIPT_RECEIVE_BEFORE_PRICES);
    }

    const toCardIds = new Set(decision.applyToCard ?? []);
    const toReceiptIds = new Set(decision.applyToReceipt ?? []);
    const suggestions = await this.buildPriceSuggestions(businessId, receipt);
    const toCard = suggestions.filter((s) => toCardIds.has(s.productId));
    const toReceipt = suggestions.filter(
      (s) => !toCardIds.has(s.productId) && toReceiptIds.has(s.productId),
    );
    if (toCard.length === 0 && toReceipt.length === 0) {
      throw new AppException(ErrorCode.RECEIPT_NO_PRICES_TO_APPLY);
    }

    const actor = await this.resolveCashier(account);

    await this.dbService.db.transaction(async (tx) => {
      // The receipt was right: the card takes its price, and the shop starts
      // selling at it.
      for (const s of toCard) {
        const set: Record<string, string | Date> = {updatedAt: new Date()};
        for (const field of s.changes) {
          const value = s.proposed[field];
          if (value != null) set[field] = value;
        }
        await tx
          .update(products)
          .set(set)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, s.productId),
            ),
          );
        // The same history a hand-edited card writes, pointing back at the
        // document the figure came from.
        await recordPriceChangesTx(tx, {
          businessId,
          productId: s.productId,
          before: s.current,
          after: Object.fromEntries(
            s.changes.map((f) => [f, s.proposed[f]]),
          ) as Record<string, string | null>,
          origin: {source: 'receipt', receiptId},
          actor,
        });
      }

      // The card was right and the line carries a typo — 150 000 where the
      // shop sells at 15 000. The line takes the card's figure, so document
      // and shelf agree and this difference stops being reported for ever.
      // Only fields the card actually prices are written: a card with no
      // price says nothing, and writing that nothing into the document would
      // replace a wrong number with an empty one.
      for (const s of toReceipt) {
        const set: Record<string, string> = {};
        const before: Record<string, string | null> = {};
        const after: Record<string, string | null> = {};
        for (const field of s.changes) {
          const cardValue = s.current[field];
          if (cardValue == null || !(Number(cardValue) > 0)) continue;
          set[field] = cardValue;
          before[field] = s.proposed[field];
          after[field] = cardValue;
        }
        if (Object.keys(set).length === 0) continue;
        await tx
          .update(goodsReceiptItems)
          .set(set)
          .where(
            and(
              eq(goodsReceiptItems.businessId, businessId),
              eq(goodsReceiptItems.receiptId, receiptId),
              eq(goodsReceiptItems.productId, s.productId),
            ),
          );
        // Logged like a card change, but source 'receipt_line' says the row
        // describes the DOCUMENT's price moving, not the shelf's. Without it
        // the figure somebody typed would vanish with nothing to show for it —
        // the same silence that made "the price changed by itself" take a day
        // to answer.
        await recordPriceChangesTx(tx, {
          businessId,
          productId: s.productId,
          before,
          after,
          origin: {source: 'receipt_line', receiptId},
          actor,
        });
      }
    });

    return {applied: toCard.length + toReceipt.length, toCard, toReceipt};
  }

  /** Shared by the proposal and by applying it, so the two cannot drift. */
  private async buildPriceSuggestions(
    businessId: string,
    receipt: ReceiptWithItems,
  ): Promise<PriceSuggestion[]> {
    const proposed = new Map<
      string,
      {
        priceOut: string | null;
        priceWholesale: string | null;
        priceBundle: string | null;
      }
    >();
    for (const item of receipt.items) {
      if (!item.productId) continue;
      const cur = proposed.get(item.productId) ?? {
        priceOut: null,
        priceWholesale: null,
        priceBundle: null,
      };
      // Last line naming a price wins; a blank leaves the earlier one standing.
      if (item.priceOut != null) cur.priceOut = item.priceOut;
      if (item.priceWholesale != null) cur.priceWholesale = item.priceWholesale;
      if (item.priceBundle != null) cur.priceBundle = item.priceBundle;
      proposed.set(item.productId, cur);
    }
    if (proposed.size === 0) return [];

    const cards = await this.dbService.db
      .select({
        id: products.id,
        name: products.name,
        priceOut: products.priceOut,
        priceWholesale: products.priceWholesale,
        priceBundle: products.priceBundle,
      })
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          inArray(products.id, [...proposed.keys()]),
        ),
      );

    // Money carries two decimals: below half a tiyin is the same price.
    const differs = (a: string | null, b: string | null): boolean =>
      b != null && (a == null || Math.abs(Number(a) - Number(b)) > 0.005);

    const out: PriceSuggestion[] = [];
    for (const card of cards) {
      const want = proposed.get(card.id);
      if (!want) continue;
      const changes: PriceField[] = [];
      if (differs(card.priceOut, want.priceOut)) changes.push('priceOut');
      if (differs(card.priceWholesale, want.priceWholesale)) {
        changes.push('priceWholesale');
      }
      if (differs(card.priceBundle, want.priceBundle)) {
        changes.push('priceBundle');
      }
      if (changes.length === 0) continue;
      out.push({
        productId: card.id,
        productName: card.name,
        current: {
          priceOut: card.priceOut,
          priceWholesale: card.priceWholesale,
          priceBundle: card.priceBundle,
        },
        proposed: want,
        changes,
      });
    }
    return out;
  }

  // ─── Supplier returns (T3) ────────────────────────────────────────────────

  /** Returns made against a receipt, newest first. */
  async getReturns(
    businessId: string,
    receiptId: string,
  ): Promise<SupplierReturn[]> {
    return this.dbService.db
      .select()
      .from(supplierReturns)
      .where(
        and(
          eq(supplierReturns.businessId, businessId),
          eq(supplierReturns.receiptId, receiptId),
        ),
      )
      .orderBy(desc(supplierReturns.createdAt));
  }

  /**
   * Return received goods to the supplier: reverse stock and the receipt's
   * inventory batches (oldest-first, at their purchase cost), and reduce the
   * amount owed on the receipt (settled = paid + returned). One transaction so
   * stock, batches and the receipt stay consistent. No cash movement — returned
   * goods reduce the obligation rather than moving money.
   */
  async createReturn(
    businessId: string,
    receiptId: string,
    dto: CreateReturnDto,
    account?: IAccount,
  ): Promise<{return: SupplierReturn; receipt: GoodsReceipt}> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    if (receipt.status === 'draft') {
      throw new AppException(ErrorCode.RECEIPT_RECEIVE_BEFORE_RETURN);
    }

    // Aggregate requested quantities per product (sum duplicate lines).
    const requested = new Map<string, number>();
    for (const line of dto.items) {
      if (line.quantity <= 0) continue;
      requested.set(
        line.productId,
        (requested.get(line.productId) ?? 0) + line.quantity,
      );
    }
    if (requested.size === 0) {
      throw new AppException(ErrorCode.RECEIPT_NOTHING_TO_RETURN);
    }

    // Receipt lines (product names) + the receipt's open batches for reversal.
    const receiptItems = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));
    const nameByProduct = new Map<string, string>();
    // Original unit cost per receipt line (receipt currency) — the return value
    // reduces the debt in the receipt currency, not the base UZS batch cost.
    const priceInByItem = new Map<string, number>();
    for (const it of receiptItems) {
      if (it.productId) nameByProduct.set(it.productId, it.productName);
      priceInByItem.set(it.id, Number(it.priceIn));
    }
    const itemIds = receiptItems.map((it) => it.id);

    // Unit type per returned product, so weighed goods count as one item (their
    // fractional kg isn't a piece count) — keeps itemCount whole.
    const requestedIds = [...requested.keys()];
    const productMeta = requestedIds.length
      ? await this.dbService.db
          .select({id: products.id, quantityType: products.quantityType})
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              inArray(products.id, requestedIds),
            ),
          )
      : [];
    const qtyTypeByProduct = new Map(
      productMeta.map((p) => [p.id, p.quantityType]),
    );

    const cashier = await this.resolveCashier(account);
    const currency = receipt.currency ?? 'UZS';
    const returnId = generateId();

    const returnBranchId =
      receipt.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;
    return this.dbService.db.transaction(async (tx) => {
      // The receipt row is taken first, before any lot or stock row — the order
      // un-receiving and deleting take them in. Taken last, a return racing an
      // un-receive of the same receipt would hold the lots while waiting for
      // the row the other side holds, and one of them would die in a deadlock.
      const locked = await this.lockReceiptTx(tx, businessId, receiptId);

      // The lots this return draws down, locked, and only then checked against.
      // Planned outside the transaction — as this once was — two tills
      // returning the same units both passed a check only one of them could
      // honour, and each wrote an absolute qtyRemaining over the other's: a
      // delivery of 10 could go back twice.
      const batches = itemIds.length
        ? await tx
            .select()
            .from(inventoryBatches)
            .where(
              and(
                eq(inventoryBatches.businessId, businessId),
                inArray(inventoryBatches.receiptItemId, itemIds),
                gt(inventoryBatches.qtyRemaining, 0),
              ),
            )
            .orderBy(asc(inventoryBatches.createdAt))
            .for('update')
        : [];
      const batchesByProduct = new Map<string, typeof batches>();
      for (const b of batches) {
        const list = batchesByProduct.get(b.productId) ?? [];
        list.push(b);
        batchesByProduct.set(b.productId, list);
      }

      // Plan the reversal: consume the receipt's batches oldest-first and value
      // each returned unit at that batch's purchase cost.
      const returnLines: {
        productId: string;
        productName: string;
        quantity: number;
        priceIn: string;
        lineTotal: string;
      }[] = [];
      const batchUpdates: {id: string; take: number}[] = [];
      let returnTotal = 0;
      let returnedQty = 0;

      for (const [productId, qty] of requested) {
        const name = nameByProduct.get(productId);
        if (!name) {
          throw new AppException(ErrorCode.RECEIPT_PRODUCT_NOT_ON_RECEIPT, {
            productId,
          });
        }
        const pb = batchesByProduct.get(productId) ?? [];
        const available = pb.reduce((s, b) => s + b.qtyRemaining, 0);
        if (qty > available) {
          throw new AppException(ErrorCode.RECEIPT_RETURN_EXCEEDS_STOCK, {
            qty,
            name,
            available,
          });
        }
        let toReturn = qty;
        let lineValue = 0;
        for (const b of pb) {
          if (toReturn <= 0) break;
          const take = Math.min(toReturn, b.qtyRemaining);
          // Value the return at the line's original (receipt-currency) cost.
          const unit = b.receiptItemId
            ? (priceInByItem.get(b.receiptItemId) ?? Number(b.priceIn))
            : Number(b.priceIn);
          lineValue += take * unit;
          toReturn -= take;
          batchUpdates.push({id: b.id, take});
        }
        returnTotal += lineValue;
        returnedQty += qtyTypeByProduct.get(productId) === 'kg' ? 1 : qty;
        returnLines.push({
          productId,
          productName: name,
          quantity: qty,
          priceIn: money(qty > 0 ? lineValue / qty : 0),
          lineTotal: money(lineValue),
        });
      }

      const [ret] = await tx
        .insert(supplierReturns)
        .values({
          id: returnId,
          businessId,
          receiptId,
          supplierId: receipt.supplierId,
          supplierName: receipt.supplierName,
          totalAmount: money(returnTotal),
          currency,
          itemCount: returnedQty,
          note: dto.note ?? null,
          cashierId: cashier.id,
          cashierName: cashier.name,
        })
        .returning();

      await tx.insert(supplierReturnItems).values(
        returnLines.map((l) => ({
          id: generateId(),
          returnId,
          businessId,
          productId: l.productId,
          productName: l.productName,
          priceIn: l.priceIn,
          quantity: l.quantity,
          lineTotal: l.lineTotal,
        })),
      );

      // Reverse the batches (reduce qtyRemaining) — relative to what the row
      // holds now, not to a figure read before the lock.
      for (const u of batchUpdates) {
        await tx
          .update(inventoryBatches)
          .set({
            qtyRemaining: sql`ROUND((${inventoryBatches.qtyRemaining} - ${u.take})::numeric, 3)`,
          })
          .where(eq(inventoryBatches.id, u.id));
      }

      // … and the stock by the same amount, off the receipt's branch (and the
      // products.quantity sum), keeping the batch ↔ stock invariant.
      for (const [productId, qty] of requested) {
        await tx
          .insert(branchStock)
          .values({
            id: generateId(),
            businessId,
            productId,
            branchId: returnBranchId,
            quantity: -qty,
          })
          .onConflictDoUpdate({
            target: [branchStock.productId, branchStock.branchId],
            set: {
              quantity: sql`ROUND((${branchStock.quantity} - ${qty})::numeric, 3)`,
              updatedAt: new Date(),
            },
          });
        await tx
          .update(products)
          .set({
            quantity: sql`GREATEST(0, ROUND((${products.quantity} - ${qty})::numeric, 3))`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, productId),
            ),
          );
      }

      // Settle from the locked row: a payment committed since this return was
      // planned must count toward the status, and its amount must not be
      // written back over.
      const newReturned = Number(locked.returnedAmount) + returnTotal;
      const [updated] = await tx
        .update(goodsReceipts)
        .set({
          returnedAmount: money(newReturned),
          paymentStatus: paymentStatusOf(
            Number(locked.paidAmount) + newReturned,
            Number(locked.totalAmount),
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        )
        .returning();

      return {return: ret, receipt: updated};
    });
  }
}

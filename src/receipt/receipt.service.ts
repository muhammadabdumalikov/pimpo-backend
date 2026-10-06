import {Injectable, Inject, Logger} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {isStockTakeActive} from '../common/stock-take-lock';
import {assertReasonNote} from '../common/loss-reasons';
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
  productPriceHistory,
  productPriceSteps,
  type GoodsReceipt,
  type GoodsReceiptItem,
  type SupplierPayment,
  type SupplierReturn,
  type SupplierReturnItem,
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
  notInArray,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {FinanceService} from '../finance/finance.service';
import {BranchService} from '../branch/branch.service';
import {PriceStepService} from '../price-step/price-step.service';
import {CreateReceiptDto} from './dto/create-receipt.dto';
import {UpdateReceiptDto} from './dto/update-receipt.dto';
import {UpdateReceiptHeaderDto} from './dto/update-receipt-header.dto';
import {AddPaymentDto} from './dto/add-payment.dto';
import {CreateReturnDto} from './dto/create-return.dto';
import {displayAmount} from '../common/display-amount';
import {
  addCreditTx,
  creditBalanceTx,
  lockSupplierTx,
} from '../common/supplier-credit';
import {recordPriceChangesTx} from '../common/price-history';
import {
  NON_SHELF_SOURCES,
  PRICE_FIELDS,
  cancelPriceStepsTx,
  cancelReceiptStepsTx,
  hasOlderStockTx,
  pendingStepsTx,
  planPrice,
  productsWithOlderStock,
  queueStepTx,
} from '../common/price-steps';
import {priceFlags, isSevere, type PriceFlag} from '../common/price-risk';

function money(value: number): string {
  return value.toFixed(2);
}

/**
 * Roll what is settled against the total into a status. Settled is what was
 * paid PLUS what was returned — goods sent back reduce the debt as surely as
 * money does, so every caller passes both. Compared in whole cents: USD lines
 * sum in floating point, and 99.99999 must still read as paid.
 */
export function paymentStatusOf(settled: number, total: number): string {
  const settledCents = Math.round(settled * 100);
  if (settledCents <= 0) return 'unpaid';
  if (settledCents >= Math.round(total * 100)) return 'paid';
  return 'partial';
}

/** What is still owed on a receipt, never below zero, to the cent. */
export function outstandingOf(receipt: GoodsReceipt): number {
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
  /**
   * Which of the three actually differ — the rest are left alone. A figure the
   * card's waiting chain already ends on is not a difference: it is on its way.
   */
  changes: PriceField[];
  /**
   * The changes that will not reach the card at once: drops that wait for the
   * stock received before this delivery to sell out ("navbatdagi narx").
   */
  defer: PriceField[];
  /**
   * What this product cost on this receipt, in base UZS — the floor a selling
   * price is judged against, and what the margin is read from. Null when the
   * receipt names no cost for it.
   */
  priceIn: string | null;
  /**
   * Why this row is worth a look, across every tier it changes. Empty is the
   * ordinary case; anything here means the dialog must not pre-accept the row.
   */
  flags: PriceFlag[];
  /**
   * Set alongside the 'cardMoved' flag: when the card was last moved off the
   * figure this document still carries, and who moved it. The evidence behind
   * the flag, so the owner is told whose decision they are about to undo.
   */
  cardMoved: {at: string; by: string | null} | null;
}

/**
 * Sort weight for the review list. A dialog is read from the top and pressed
 * from the bottom, so the rows that must not be waved through go first: a
 * certain mistake, then a decision this document would undo, then a big move,
 * then the ordinary repricings nobody needs to stop on.
 */
function rank(s: PriceSuggestion): number {
  if (isSevere(s.flags)) return 3;
  if (s.flags.includes('cardMoved')) return 2;
  return s.flags.length > 0 ? 1 : 0;
}

@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly financeService: FinanceService,
    private readonly branchService: BranchService,
    private readonly priceSteps: PriceStepService,
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
    account?: IAccount,
    // Put the lines' selling prices on the cards as the goods land. The
    // controller says yes only for an account with product:update.
    applyPricesOnReceive = false,
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

    // Its own step, after the stock transaction: a price that cannot be
    // written must never undo a delivery that was.
    if (!draft && applyPricesOnReceive) {
      await this.applyPricesOnReceive(businessId, receiptId, account);
    }

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
    account?: IAccount,
    applyPricesOnReceive = false,
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

    // See create: the selling prices follow the goods onto the shelf.
    if (applyPricesOnReceive) {
      await this.applyPricesOnReceive(businessId, receiptId, account);
    }

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
    account?: IAccount,
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
    const actor = await this.resolveCashier(account);

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
      // Its lots are gone, so are the lower prices that waited behind them.
      await cancelReceiptStepsTx(tx, businessId, receiptId, {
        reason: 'unreceive',
        actor,
      });
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

    // Older stock left the shelf with it: later deliveries' waiting prices
    // may be due now.
    await this.priceSteps.settle(businessId, [
      ...new Set(
        items.map((i) => i.productId).filter((id): id is string => !!id),
      ),
    ]);

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

      let payment: SupplierPayment;
      if (dto.source === 'credit') {
        // Paid out of the supplier's credit (S16): no money moves, so no
        // Moliya row — the credit ledger goes down instead. The supplier row
        // is locked after the receipt, the order every credit write keeps.
        if (!receipt.supplierId) {
          throw new AppException(ErrorCode.SUPPLIER_CREDIT_NO_SUPPLIER);
        }
        await lockSupplierTx(tx, businessId, receipt.supplierId);
        const available = await creditBalanceTx(
          tx,
          businessId,
          receipt.supplierId,
          currency,
        );
        if (Math.round(dto.amount * 100) > Math.round(available * 100)) {
          throw new AppException(ErrorCode.SUPPLIER_CREDIT_INSUFFICIENT, {
            available: displayAmount(Math.max(0, available)),
            currency,
          });
        }
        [payment] = await tx
          .insert(supplierPayments)
          .values({
            id: generateId(),
            businessId,
            receiptId,
            supplierId: receipt.supplierId,
            supplierName: receipt.supplierName,
            amount: money(dto.amount),
            currency,
            source: 'credit',
            note: dto.note ?? null,
            cashierId: cashier.id,
            cashierName: cashier.name,
            paidAt,
          })
          .returning();
        await addCreditTx(tx, {
          businessId,
          supplierId: receipt.supplierId,
          currency,
          amount: -dto.amount,
          kind: 'payment',
          supplierPaymentId: payment.id,
          receiptId,
          note: dto.note ?? null,
          cashierId: cashier.id,
          cashierName: cashier.name,
        });
      } else {
        const txn = await this.financeService.recordExpenseTx(tx, businessId, {
          source: 'supplier_payment',
          accountId: dto.accountId,
          external: dto.external,
          allowNegative: dto.allowNegative,
          amount: dto.amount,
          currency,
          note:
            dto.note ??
            `Yetkazib beruvchiga to'lov${receipt.supplierName ? `: ${receipt.supplierName}` : ''}`,
          cashierId: cashier.id,
          cashierName: cashier.name,
        });

        [payment] = await tx
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
      }

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

  // ─── Till payments ("Ta'minotchiga to'lov") ──────────────────────────────

  /**
   * A supplier's open receipts in one currency, oldest first — the order a
   * till payment settles them in. `lock` takes them FOR UPDATE, so a payment
   * entered on the nakladnoy page at the same moment either lands first (and
   * is seen here) or waits for this one.
   */
  private async openReceipts(
    db: DbTx | DatabaseService['db'],
    businessId: string,
    supplierId: string,
    currency: string,
    lock = false,
  ): Promise<GoodsReceipt[]> {
    const query = db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          eq(goodsReceipts.supplierId, supplierId),
          eq(goodsReceipts.currency, currency),
          ne(goodsReceipts.status, 'draft'),
          sql`round((${goodsReceipts.totalAmount} - ${goodsReceipts.paidAmount} - ${goodsReceipts.returnedAmount}) * 100) > 0`,
        ),
      )
      .orderBy(asc(goodsReceipts.createdAt), asc(goodsReceipts.id));
    return lock ? query.for('update') : query;
  }

  /**
   * What the till shows before paying a supplier: their open receipts (oldest
   * first, as they will be settled), the debt they add up to, and the advance
   * already standing with them.
   */
  async tillDebt(businessId: string, supplierId: string, currency: string) {
    const db = this.dbService.db;
    const [supplier] = await db
      .select({id: suppliers.id, name: suppliers.name})
      .from(suppliers)
      .where(
        and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)),
      )
      .limit(1);
    if (!supplier) throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);

    const [open, advance] = await Promise.all([
      this.openReceipts(db, businessId, supplierId, currency),
      creditBalanceTx(db, businessId, supplierId, currency),
    ]);
    const receipts = open.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      total: Number(r.totalAmount),
      outstanding: outstandingOf(r),
    }));
    const debtCents = receipts.reduce(
      (s, r) => s + Math.round(r.outstanding * 100),
      0,
    );
    return {
      supplierId: supplier.id,
      supplierName: supplier.name,
      currency,
      debt: debtCents / 100,
      advance,
      receipts,
    };
  }

  /**
   * Pay a supplier "towards what we owe" rather than one nakladnoy: `open`,
   * their unpaid receipts (locked, oldest first), are paid in order, each as
   * an ordinary supplier payment — it reads, and cancels, exactly like one
   * entered on the nakladnoy page — and whatever is left becomes their
   * advance ("Avans"), spent later with "Avansdan". `book` writes the money
   * leg (the till's or a Moliya account's) and returns its ledger row; every
   * leg is a supplier payment, so none of it reaches the P&L as an expense:
   * the goods' cost arrives there as COGS when they sell.
   *
   * Oldest first is what "here is money towards what we owe" means, and it
   * leaves the open debt on the newest goods. The supplier row is locked only
   * for the advance, after the receipts — the order addPayment's credit path
   * keeps, so the two can never wait on each other in a circle.
   */
  private async settleOldestFirstTx(
    tx: DbTx,
    businessId: string,
    open: GoodsReceipt[],
    p: {
      supplierId: string;
      supplierName: string;
      currency: string;
      amount: number;
      cashierId: string | null;
      cashierName: string | null;
      /** On each supplier_payments row. */
      paymentNote: string | null;
      /** On the advance's credit row. */
      advanceNote: string | null;
      book: (
        amount: number,
        advance: boolean,
      ) => Promise<{
        id: string;
        accountId: string | null;
        accountName: string | null;
      }>;
    },
  ): Promise<{
    payments: {receiptId: string; receiptCreatedAt: Date; amount: number}[];
    advance: number;
  }> {
    // Whole cents throughout: USD receipts carry fractions, and the last
    // receipt must close exactly, not at 99.99999.
    let left = Math.round(p.amount * 100);
    const payments: {
      receiptId: string;
      receiptCreatedAt: Date;
      amount: number;
    }[] = [];
    for (const receipt of open) {
      if (left <= 0) break;
      const cents = Math.min(left, Math.round(outstandingOf(receipt) * 100));
      if (cents <= 0) continue;
      const amount = cents / 100;

      const txn = await p.book(amount, false);
      await tx.insert(supplierPayments).values({
        id: generateId(),
        businessId,
        receiptId: receipt.id,
        supplierId: p.supplierId,
        supplierName: receipt.supplierName ?? p.supplierName,
        amount: money(amount),
        currency: p.currency,
        accountId: txn.accountId,
        accountName: txn.accountName,
        financialTransactionId: txn.id,
        note: p.paymentNote,
        cashierId: p.cashierId,
        cashierName: p.cashierName,
        paidAt: new Date(),
      });
      const newPaid = Number(receipt.paidAmount) + amount;
      await tx
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
            eq(goodsReceipts.id, receipt.id),
            eq(goodsReceipts.businessId, businessId),
          ),
        );

      payments.push({
        receiptId: receipt.id,
        receiptCreatedAt: receipt.createdAt,
        amount,
      });
      left -= cents;
    }

    const advance = left / 100;
    if (left > 0) {
      await lockSupplierTx(tx, businessId, p.supplierId);
      await p.book(advance, true);
      await addCreditTx(tx, {
        businessId,
        supplierId: p.supplierId,
        currency: p.currency,
        amount: advance,
        kind: 'advance',
        note: p.advanceNote,
        cashierId: p.cashierId,
        cashierName: p.cashierName,
      });
    }

    return {payments, advance: Math.max(0, advance)};
  }

  /**
   * Settle a supplier's debt with till money ("Ta'minotchiga to'lov" on the
   * kassa), inside the shift's transaction. Every leg is tied to the cash
   * movement that took the money out of the drawer.
   */
  async payFromTillTx(
    tx: DbTx,
    businessId: string,
    p: {
      supplierId: string;
      supplierName: string;
      amount: number;
      reason: string | null;
      movement: {
        id: string;
        shiftId: string;
        isCash: boolean;
        currency: string;
        cashierId: string | null;
        cashierName: string | null;
      };
      register: {id: string; name: string | null};
    },
  ): Promise<{
    payments: {receiptId: string; receiptCreatedAt: Date; amount: number}[];
    advance: number;
  }> {
    const {movement} = p;
    const suffix = p.reason ? ` — ${p.reason}` : '';
    const open = await this.openReceipts(
      tx,
      businessId,
      p.supplierId,
      movement.currency,
      true,
    );
    return this.settleOldestFirstTx(tx, businessId, open, {
      supplierId: p.supplierId,
      supplierName: p.supplierName,
      currency: movement.currency,
      amount: p.amount,
      cashierId: movement.cashierId,
      cashierName: movement.cashierName,
      paymentNote: `Kassadan${suffix}`,
      advanceNote: p.reason,
      book: (amount, advance) =>
        this.financeService.recordTillSupplierPaymentTx(
          tx,
          businessId,
          movement,
          p.register,
          amount,
          `${advance ? 'Yetkazib beruvchiga avans' : "Yetkazib beruvchiga to'lov"} (kassa): ${p.supplierName}${suffix}`,
        ),
    });
  }

  /**
   * "Ta'minotchiga to'lov" from Moliya: a shop account — or the owner's own
   * pocket, "Tashqi mablag'" — pays a supplier towards what we owe, settled
   * as the till's version is. From Tashqi mablag' each leg also books the
   * owner's capital kirim, which is how money the owner put straight into
   * goods reaches the capital figure instead of a fake loss.
   *
   * The whole sum is checked against the account once, after the receipts
   * are locked (receipt → balance → supplier, the order addPayment keeps):
   * one refusal with the full shortfall, not one halfway through the legs.
   */
  async payFromAccount(
    businessId: string,
    supplierId: string,
    dto: {
      accountId?: string;
      external?: boolean;
      allowNegative?: boolean;
      amount: number;
      currency?: string;
      note?: string;
    },
    account?: IAccount,
  ): Promise<{
    payments: {receiptId: string; receiptCreatedAt: Date; amount: number}[];
    advance: number;
  }> {
    const cashier = await this.resolveCashier(account);
    const currency = dto.currency === 'USD' ? 'USD' : 'UZS';
    const note = dto.note?.trim() || null;
    const suffix = note ? ` — ${note}` : '';

    return this.dbService.db.transaction(async (tx) => {
      const [supplier] = await tx
        .select({id: suppliers.id, name: suppliers.name})
        .from(suppliers)
        .where(
          and(
            eq(suppliers.id, supplierId),
            eq(suppliers.businessId, businessId),
          ),
        )
        .limit(1);
      if (!supplier) throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);

      const open = await this.openReceipts(
        tx,
        businessId,
        supplierId,
        currency,
        true,
      );
      if (!dto.external) {
        if (!dto.accountId) {
          throw new AppException(ErrorCode.FINANCE_ACCOUNT_NOT_FOUND);
        }
        await this.financeService.assertAccountCoversTx(
          tx,
          businessId,
          dto.accountId,
          currency,
          dto.amount,
          dto.allowNegative,
        );
      }

      return this.settleOldestFirstTx(tx, businessId, open, {
        supplierId,
        supplierName: supplier.name,
        currency,
        amount: dto.amount,
        cashierId: cashier.id,
        cashierName: cashier.name,
        paymentNote: note,
        advanceNote: note,
        book: (amount, advance) =>
          this.financeService.recordExpenseTx(tx, businessId, {
            source: 'supplier_payment',
            accountId: dto.accountId,
            external: dto.external,
            // The whole sum was checked (or confirmed) above.
            allowNegative: true,
            amount,
            currency,
            note: `${advance ? 'Yetkazib beruvchiga avans' : "Yetkazib beruvchiga to'lov"}: ${supplier.name}${suffix}`,
            cashierId: cashier.id,
            cashierName: cashier.name,
          }),
      });
    });
  }

  /**
   * "Avansni o'tkazish": move part or all of a supplier's advance to another
   * supplier.
   *
   * For money booked to the wrong name — a till payment to the wrong
   * supplier, or old payments parked on a temporary one until the owner knows
   * whose they were. No money moves and Moliya is not touched: the cash left
   * long ago, only whose advance it is changes. With `settle` (the default)
   * the moved sum then pays the new supplier's open receipts oldest first,
   * each exactly as "Avansdan" on that receipt would, and what is left stays
   * their advance.
   *
   * Receipts are locked before supplier rows, as in every credit write, and
   * the two suppliers in id order, so two transfers between the same pair in
   * opposite directions queue instead of deadlocking.
   */
  async transferAdvance(
    businessId: string,
    fromSupplierId: string,
    dto: {
      toSupplierId: string;
      amount: number;
      currency?: string;
      settle?: boolean;
      note?: string;
    },
    account?: IAccount,
  ): Promise<{
    transferred: number;
    payments: {receiptId: string; receiptCreatedAt: Date; amount: number}[];
    advanceLeft: number;
  }> {
    if (dto.toSupplierId === fromSupplierId) {
      throw new AppException(ErrorCode.SUPPLIER_ADVANCE_SAME_SUPPLIER);
    }
    const cashier = await this.resolveCashier(account);
    const currency = dto.currency ?? 'UZS';
    const settle = dto.settle ?? true;
    const note = dto.note?.trim() || null;

    return this.dbService.db.transaction(async (tx) => {
      const pair = await tx
        .select({id: suppliers.id, name: suppliers.name})
        .from(suppliers)
        .where(
          and(
            eq(suppliers.businessId, businessId),
            inArray(suppliers.id, [fromSupplierId, dto.toSupplierId]),
          ),
        );
      const from = pair.find((s) => s.id === fromSupplierId);
      const to = pair.find((s) => s.id === dto.toSupplierId);
      if (!from || !to) throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);

      const open = settle
        ? await this.openReceipts(tx, businessId, to.id, currency, true)
        : [];
      for (const id of [from.id, to.id].sort()) {
        await lockSupplierTx(tx, businessId, id);
      }

      const available = await creditBalanceTx(tx, businessId, from.id, currency);
      const cents = Math.round(dto.amount * 100);
      if (cents > Math.round(available * 100)) {
        throw new AppException(ErrorCode.SUPPLIER_CREDIT_INSUFFICIENT, {
          available: displayAmount(Math.max(0, available)),
          currency,
        });
      }
      const amount = cents / 100;
      const actor = {cashierId: cashier.id, cashierName: cashier.name};
      await addCreditTx(tx, {
        businessId,
        supplierId: from.id,
        currency,
        amount: -amount,
        kind: 'transfer_out',
        relatedSupplierId: to.id,
        relatedSupplierName: to.name,
        note,
        ...actor,
      });
      await addCreditTx(tx, {
        businessId,
        supplierId: to.id,
        currency,
        amount,
        kind: 'transfer_in',
        relatedSupplierId: from.id,
        relatedSupplierName: from.name,
        note,
        ...actor,
      });

      let left = cents;
      const payments: {receiptId: string; receiptCreatedAt: Date; amount: number}[] =
        [];
      for (const receipt of open) {
        if (left <= 0) break;
        const pay = Math.min(left, Math.round(outstandingOf(receipt) * 100));
        if (pay <= 0) continue;
        const payAmount = pay / 100;

        const [payment] = await tx
          .insert(supplierPayments)
          .values({
            id: generateId(),
            businessId,
            receiptId: receipt.id,
            supplierId: to.id,
            supplierName: receipt.supplierName ?? to.name,
            amount: money(payAmount),
            currency,
            source: 'credit',
            note: `Avansdan (${from.name})`,
            cashierId: cashier.id,
            cashierName: cashier.name,
            paidAt: new Date(),
          })
          .returning();
        await addCreditTx(tx, {
          businessId,
          supplierId: to.id,
          currency,
          amount: -payAmount,
          kind: 'payment',
          supplierPaymentId: payment.id,
          receiptId: receipt.id,
          ...actor,
        });
        const newPaid = Number(receipt.paidAmount) + payAmount;
        await tx
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
              eq(goodsReceipts.id, receipt.id),
              eq(goodsReceipts.businessId, businessId),
            ),
          );

        payments.push({
          receiptId: receipt.id,
          receiptCreatedAt: receipt.createdAt,
          amount: payAmount,
        });
        left -= pay;
      }

      return {transferred: amount, payments, advanceLeft: left / 100};
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
      if (payment.source === 'credit' && payment.supplierId) {
        // Paid from the supplier's credit: the credit comes back.
        await lockSupplierTx(tx, businessId, payment.supplierId);
        await addCreditTx(tx, {
          businessId,
          supplierId: payment.supplierId,
          currency: payment.currency,
          amount,
          kind: 'payment_cancel',
          supplierPaymentId: payment.id,
          receiptId,
          cashierId: cashier.id,
          cashierName: cashier.name,
        });
      }
      // A payment with no booked expense behind it (a credit payment, or an
      // old row with the nullable columns empty) has nothing in Moliya to
      // answer.
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
   * The prices this receipt put in the queue ("navbatdagi narx") and where
   * each stands now: waiting for the older stock, taken effect, or dropped.
   */
  async getPriceSteps(businessId: string, receiptId: string) {
    const [receipt] = await this.dbService.db
      .select({id: goodsReceipts.id})
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    return this.priceSteps.receiptSteps(businessId, receiptId);
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
    // Products whose lower price now waits for the older stock to sell out.
    queued: number;
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

    const {queued} = await this.writePrices(
      businessId,
      receiptId,
      toCard,
      toReceipt,
      account,
    );

    return {
      applied: toCard.length + toReceipt.length,
      queued: queued.length,
      toCard,
      toReceipt,
    };
  }

  /**
   * Put a receipt's selling prices on the cards as it is received — every
   * product whose line names a price the card does not have.
   *
   * The form showed the card's price beside each line while it was typed,
   * coloured by the direction of the change, and said that receiving would
   * change some selling prices; this is that change. One exception: a card
   * edited AFTER the line was written (`cardMoved`). Such a line carries the
   * card's former price, not a new one, and writing it would undo the edit —
   * the very thing that made "the price changes by itself" a bug. Those rows
   * are left for the review dialog on the receipt page.
   *
   * Never throws: the goods are on the shelf, and a price that could not be
   * written is shown there, not lost.
   */
  private async applyPricesOnReceive(
    businessId: string,
    receiptId: string,
    account?: IAccount,
  ): Promise<void> {
    try {
      const receipt = await this.findOne(businessId, receiptId);
      if (!receipt || receipt.status === 'draft') return;
      const suggestions = await this.buildPriceSuggestions(businessId, receipt);
      const toCard = suggestions.filter((s) => !s.flags.includes('cardMoved'));
      if (toCard.length === 0) return;
      await this.writePrices(businessId, receiptId, toCard, [], account);
    } catch (err) {
      this.logger.error(
        `Applying prices on receive failed for receipt ${receiptId}: ${String(err)}`,
      );
    }
  }

  /**
   * The one place a receipt's prices are written, both ways — by the review
   * dialog and by receiving.
   */
  private async writePrices(
    businessId: string,
    receiptId: string,
    toCard: PriceSuggestion[],
    toReceipt: PriceSuggestion[],
    account?: IAccount,
  ): Promise<{queued: string[]}> {
    const actor = await this.resolveCashier(account);

    const defer = await this.deferPriceDrops(businessId);
    const queued: string[] = [];

    await this.dbService.db.transaction(async (tx) => {
      // The receipt was right: the card takes its price — at once when it is
      // a rise, or when nothing older is left on the shelf; a drop waits in
      // product_price_steps until the stock received before this delivery
      // has sold out (common/price-steps.ts).
      for (const s of toCard) {
        // The card under lock, read fresh: the proposal was built outside
        // this transaction, and every price decision for the product queues
        // behind this row.
        const [card] = await tx
          .select({
            priceOut: products.priceOut,
            priceWholesale: products.priceWholesale,
            priceBundle: products.priceBundle,
          })
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, s.productId),
            ),
          )
          .for('update');
        if (!card) continue;

        const set: Record<string, string | Date> = {};
        const nowFields: PriceField[] = [];
        let olderStock: boolean | null = null;
        for (const field of s.changes) {
          const value = s.proposed[field];
          if (value == null) continue;
          const cardValue = card[field] != null ? Number(card[field]) : null;
          if (defer && olderStock == null && cardValue != null && Number(value) < cardValue) {
            olderStock = await hasOlderStockTx(tx, businessId, s.productId, receiptId);
          }
          const plan = planPrice({
            card: cardValue,
            steps: await pendingStepsTx(tx, businessId, s.productId, field),
            proposed: Number(value),
            defer,
            olderStock: olderStock ?? false,
          });
          if (plan.kind === 'now') {
            set[field] = value;
            nowFields.push(field);
          } else if (plan.kind === 'queue') {
            await queueStepTx(tx, {
              businessId,
              productId: s.productId,
              field,
              price: value,
              receiptId,
              lift: plan.lift,
              actor,
              cardPrice: card[field],
            });
            queued.push(s.productId);
          }
        }
        if (nowFields.length === 0) continue;

        await tx
          .update(products)
          .set({...set, updatedAt: new Date()})
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
          before: card,
          after: Object.fromEntries(
            nowFields.map((f) => [f, s.proposed[f]]),
          ) as Record<string, string | null>,
          origin: {source: 'receipt', receiptId},
          actor,
        });
        // A figure written now overtakes whatever was waiting for the field.
        await cancelPriceStepsTx(tx, businessId, s.productId, nowFields, {
          reason: 'receipt',
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

    return {queued: [...new Set(queued)]};
  }

  /** The shop's switch for waiting drops; on unless it was turned off. */
  private async deferPriceDrops(businessId: string): Promise<boolean> {
    const [row] = await this.dbService.db
      .select({defer: receiptSettings.deferPriceDrops})
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);
    return row?.defer ?? true;
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
    // Cost per product in base UZS. A selling price under this one loses money
    // on every unit, which is the only mistake these rules can be certain of.
    const cost = new Map<string, number>();
    const rateToBase =
      receipt.currency === 'USD' ? Number(receipt.usdRate ?? 0) : 1;
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
      // Same rule for the cost: the last line naming one is what the product
      // was bought at on this document.
      const base = Number(item.priceIn) * rateToBase;
      if (base > 0) cost.set(item.productId, base);
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

    // Where each card's waiting chain ends: a figure already on its way to the
    // card is not a difference to propose again.
    const chainEnd = new Map<string, string>();
    const steps = await this.dbService.db
      .select({
        productId: productPriceSteps.productId,
        field: productPriceSteps.field,
        price: productPriceSteps.price,
      })
      .from(productPriceSteps)
      .where(
        and(
          eq(productPriceSteps.businessId, businessId),
          inArray(productPriceSteps.productId, [...proposed.keys()]),
        ),
      )
      .orderBy(
        asc(productPriceSteps.triggerAt),
        asc(productPriceSteps.createdAt),
      );
    for (const st of steps) chainEnd.set(`${st.productId}|${st.field}`, st.price);

    // Which drops would wait: the shop's switch, and older stock on the shelf.
    const defer = await this.deferPriceDrops(businessId);
    const dropping = cards
      .filter((c) => {
        const want = proposed.get(c.id);
        return (
          want != null &&
          PRICE_FIELDS.some(
            (f) =>
              c[f] != null && want[f] != null && Number(want[f]) < Number(c[f]),
          )
        );
      })
      .map((c) => c.id);
    const withOlder = defer
      ? await productsWithOlderStock(
          this.dbService.db,
          businessId,
          receipt.id,
          dropping,
        )
      : new Set<string>();

    const out: PriceSuggestion[] = [];
    for (const card of cards) {
      const want = proposed.get(card.id);
      if (!want) continue;
      const changes: PriceField[] = [];
      const deferred: PriceField[] = [];
      for (const field of PRICE_FIELDS) {
        const end = chainEnd.get(`${card.id}|${field}`) ?? card[field];
        if (!differs(card[field], want[field]) || !differs(end, want[field])) {
          continue;
        }
        changes.push(field);
        if (
          withOlder.has(card.id) &&
          card[field] != null &&
          Number(card[field]) > 0 &&
          Number(want[field]) < Number(card[field])
        ) {
          deferred.push(field);
        }
      }
      if (changes.length === 0) continue;
      const current = {
        priceOut: card.priceOut,
        priceWholesale: card.priceWholesale,
        priceBundle: card.priceBundle,
      };
      // One row, one verdict: a tier in trouble puts the whole row in trouble,
      // because the row is what the owner accepts or refuses.
      const lineCost = cost.get(card.id) ?? null;
      const flags = new Set<PriceFlag>();
      for (const field of changes) {
        for (const flag of priceFlags({
          card: current[field] != null ? Number(current[field]) : null,
          proposed: Number(want[field]),
          cost: lineCost,
        })) {
          flags.add(flag);
        }
      }
      out.push({
        productId: card.id,
        productName: card.name,
        current,
        proposed: want,
        changes,
        defer: deferred,
        priceIn: lineCost != null ? money(lineCost) : null,
        flags: [...flags],
        cardMoved: null,
      });
    }

    await this.markMovedCards(businessId, receipt, out);

    // Trouble first. The list is read top-down and the rows that must not be
    // waved through are the ones that have to survive a fast reader.
    return out.sort((a, b) => rank(b) - rank(a));
  }

  /**
   * Flag the rows whose figure the card has already moved away from.
   *
   * The selling price on a receipt line is copied from the card when the line
   * is written (see create: `item.priceOut ?? info.priceOut`) and never
   * refreshed after. So a draft saved on Monday, a card edited by hand on
   * Tuesday and the draft received on Thursday produce a difference that looks
   * exactly like a repricing but points backwards: accepting it would undo
   * Tuesday's decision, which is the very thing this feature exists to stop.
   *
   * The evidence is in the price history: a card change made AFTER this
   * document was written whose old price is the figure the document still
   * carries. That is the card leaving this number behind, not the document
   * proposing a new one.
   */
  private async markMovedCards(
    businessId: string,
    receipt: ReceiptWithItems,
    suggestions: PriceSuggestion[],
  ): Promise<void> {
    if (suggestions.length === 0) return;
    const rows = await this.dbService.db
      .select({
        productId: productPriceHistory.productId,
        field: productPriceHistory.field,
        oldPrice: productPriceHistory.oldPrice,
        createdAt: productPriceHistory.createdAt,
        cashierName: productPriceHistory.cashierName,
      })
      .from(productPriceHistory)
      .where(
        and(
          eq(productPriceHistory.businessId, businessId),
          inArray(
            productPriceHistory.productId,
            suggestions.map((s) => s.productId),
          ),
          gt(productPriceHistory.createdAt, receipt.createdAt),
          // A DOCUMENT being corrected, a waiting price joining or leaving
          // the queue — none of these is the card moving, so none is
          // evidence of anything here.
          notInArray(productPriceHistory.source, [...NON_SHELF_SOURCES]),
        ),
      )
      .orderBy(asc(productPriceHistory.createdAt));
    if (rows.length === 0) return;

    for (const s of suggestions) {
      for (const row of rows) {
        if (row.productId !== s.productId) continue;
        if (!s.changes.includes(row.field as PriceField)) continue;
        const docPrice = s.proposed[row.field as PriceField];
        if (docPrice == null || row.oldPrice == null) continue;
        if (Math.abs(Number(row.oldPrice) - Number(docPrice)) > 0.005) continue;
        // Rows come oldest-first, so the last match wins: the most recent time
        // the card held this figure and left it.
        s.cardMoved = {
          at: row.createdAt.toISOString(),
          by: row.cashierName,
        };
      }
      if (s.cardMoved && !s.flags.includes('cardMoved')) {
        s.flags.push('cardMoved');
      }
    }
  }

  // ─── Supplier returns (T3) ────────────────────────────────────────────────

  /** Returns made against a receipt, newest first, each with its lines. */
  async getReturns(
    businessId: string,
    receiptId: string,
  ): Promise<(SupplierReturn & {items: SupplierReturnItem[]})[]> {
    const rows = await this.dbService.db
      .select()
      .from(supplierReturns)
      .where(
        and(
          eq(supplierReturns.businessId, businessId),
          eq(supplierReturns.receiptId, receiptId),
        ),
      )
      .orderBy(desc(supplierReturns.createdAt));
    const items = rows.length
      ? await this.dbService.db
          .select()
          .from(supplierReturnItems)
          .where(
            and(
              eq(supplierReturnItems.businessId, businessId),
              inArray(
                supplierReturnItems.returnId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(supplierReturnItems.createdAt))
      : [];
    const byReturn = new Map<string, SupplierReturnItem[]>();
    for (const it of items) {
      const list = byReturn.get(it.returnId) ?? [];
      list.push(it);
      byReturn.set(it.returnId, list);
    }
    return rows.map((r) => ({...r, items: byReturn.get(r.id) ?? []}));
  }

  /**
   * How much of each product can still go back to the supplier on this
   * receipt: what is left in the lots the receipt opened. Units already sold,
   * written off, moved to another branch or returned are gone from those lots,
   * so they can't be returned here — the same figure createReturn enforces.
   */
  async getReturnable(
    businessId: string,
    receiptId: string,
  ): Promise<{items: {productId: string; returnable: number}[]}> {
    const [receipt] = await this.dbService.db
      .select({id: goodsReceipts.id})
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    const rows = await this.dbService.db
      .select({
        productId: inventoryBatches.productId,
        returnable: sql<string>`COALESCE(SUM(${inventoryBatches.qtyRemaining}), 0)`,
      })
      .from(inventoryBatches)
      .innerJoin(
        goodsReceiptItems,
        eq(inventoryBatches.receiptItemId, goodsReceiptItems.id),
      )
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          eq(goodsReceiptItems.receiptId, receiptId),
          gt(inventoryBatches.qtyRemaining, 0),
        ),
      )
      .groupBy(inventoryBatches.productId);
    return {
      items: rows.map((r) => ({
        productId: r.productId,
        returnable: Math.round(Number(r.returnable) * 1000) / 1000,
      })),
    };
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

    // Aggregate requested quantities per product (sum duplicate lines) — stock
    // and lots move per product — but keep each line, since two lines of one
    // product may go back for different reasons.
    const requested = new Map<string, number>();
    const linesByProduct = new Map<
      string,
      {quantity: number; reasonCode: string | null; note: string | null}[]
    >();
    for (const line of dto.items) {
      if (line.quantity <= 0) continue;
      const reasonCode = line.reasonCode ?? dto.reasonCode ?? null;
      const note = line.note?.trim() || null;
      // 'other' is explained by the line's note, else the return's own note.
      assertReasonNote(reasonCode, note ?? dto.note);
      requested.set(
        line.productId,
        (requested.get(line.productId) ?? 0) + line.quantity,
      );
      const list = linesByProduct.get(line.productId) ?? [];
      list.push({quantity: line.quantity, reasonCode, note});
      linesByProduct.set(line.productId, list);
    }
    if (requested.size === 0) {
      throw new AppException(ErrorCode.RECEIPT_NOTHING_TO_RETURN);
    }
    // Same freeze as receiving: a count relies on a stable book snapshot, and a
    // return takes stock off the shelf just as a receipt puts it on.
    if (await isStockTakeActive(this.cache, this.dbService.db, businessId)) {
      throw new AppException(ErrorCode.RECEIPT_FROZEN_STOCK_TAKE);
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
    const result = await this.dbService.db.transaction(async (tx) => {
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
        reasonCode: string | null;
        note: string | null;
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
        // One row per requested line, all at the product's blended unit cost;
        // the last row takes the rounding remainder so rows sum to lineValue.
        const unit = qty > 0 ? lineValue / qty : 0;
        const parts = linesByProduct.get(productId) ?? [];
        let allotted = 0;
        parts.forEach((part, i) => {
          const value =
            i === parts.length - 1
              ? lineValue - allotted
              : Number(money(part.quantity * unit));
          allotted += value;
          returnLines.push({
            productId,
            productName: name,
            quantity: part.quantity,
            priceIn: money(unit),
            lineTotal: money(value),
            reasonCode: part.reasonCode,
            note: part.note,
          });
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
          reasonCode: l.reasonCode,
          note: l.note,
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

    // Lots went back to the supplier: a waiting lower price whose older stock
    // that was may now take effect.
    await this.priceSteps.settle(businessId, [...requested.keys()]);
    return result;
  }
}

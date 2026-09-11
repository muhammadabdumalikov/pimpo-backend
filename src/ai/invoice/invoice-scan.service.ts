import {Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {and, count, desc, eq, gte, inArray, lt, sql} from 'drizzle-orm';
import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import {DatabaseService} from '../../database/database.service';
import {
  businesses,
  goodsReceiptItems,
  inventoryBatches,
  InvoiceScan,
  invoiceScans,
  orderItems,
  products,
  staff,
} from '../../database/schema';
import {generateId} from '../../utils/uuid';

/**
 * Open scans one person may have started at once. A shop juggles a few
 * deliveries a day; past this it is a pile nobody will finish, and every one
 * of them may be holding products with no stock.
 */
export const MAX_OPEN_SCANS_PER_ACCOUNT = 10;

/** An untouched scan is somebody who walked away; it goes after this. */
const ABANDONED_AFTER_DAYS = 14;

/** A line in the shop's list of unfinished scans. */
export interface InvoiceScanSummary {
  id: string;
  rowCount: number;
  pageCount: number;
  createdProductCount: number;
  supplierName: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  createdByName: string | null;
  updatedByName: string | null;
  /** Started by the caller. */
  mine: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The whole scan, for picking the review back up. */
export interface InvoiceScanView extends InvoiceScanSummary {
  state: Record<string, unknown> | null;
  createdProductIds: string[];
}

/** What the drawer writes: on creation and on every autosave. */
export interface ScanWrite {
  state: Record<string, unknown>;
  rowCount: number;
  pageCount: number;
  createdProductIds: string[];
  supplierName?: string | null;
  documentNumber?: string | null;
  documentDate?: string | null;
}

/** Why a product made for the scan can't be taken back out any more. */
export type KeepReason = 'sold' | 'received' | 'stock' | 'deleted';

export interface ScanProductView {
  id: string;
  name: string;
  barcode: string | null;
  deletable: boolean;
  reason: KeepReason | null;
}

/** A scan row without its (possibly large) review state. */
type ScanHead = Omit<InvoiceScan, 'state'>;

const headColumns = {
  id: invoiceScans.id,
  businessId: invoiceScans.businessId,
  accountId: invoiceScans.accountId,
  updatedById: invoiceScans.updatedById,
  supplierName: invoiceScans.supplierName,
  documentNumber: invoiceScans.documentNumber,
  documentDate: invoiceScans.documentDate,
  rowCount: invoiceScans.rowCount,
  pageCount: invoiceScans.pageCount,
  createdProductIds: invoiceScans.createdProductIds,
  createdAt: invoiceScans.createdAt,
  updatedAt: invoiceScans.updatedAt,
};

/**
 * Delivery-note scans under review, saved as they go.
 *
 * Only the read and the owner's corrections are kept — the photos never leave
 * the request that reads them (POST /ai/invoice/parse). The drawer creates a
 * scan once its first read is back, and writes it again after every change.
 *
 * The scans belong to the shop: anyone allowed to write a receipt lists them
 * all and can finish one somebody else started. Two people in one scan at
 * once is last-write-wins by design — only the products it made are merged,
 * so a discard still knows every one of them.
 */
@Injectable()
export class InvoiceScanService {
  private readonly logger = new Logger(InvoiceScanService.name);

  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  /** The shop's unfinished scans, most recently worked on first. */
  async list(
    businessId: string,
    accountId: string,
  ): Promise<InvoiceScanSummary[]> {
    const rows = await this.db
      .select(headColumns)
      .from(invoiceScans)
      .where(eq(invoiceScans.businessId, businessId))
      .orderBy(desc(invoiceScans.updatedAt));
    const names = await this.accountNames(rows);
    return rows.map((r) => toSummary(r, accountId, names));
  }

  async get(
    businessId: string,
    accountId: string,
    scanId: string,
  ): Promise<InvoiceScanView> {
    const scan = await this.find(businessId, scanId);
    return this.toView(scan, accountId);
  }

  /** Keep a scan whose first read has just come back. */
  async create(
    businessId: string,
    accountId: string,
    data: ScanWrite,
  ): Promise<InvoiceScanView> {
    const [{open}] = await this.db
      .select({open: count()})
      .from(invoiceScans)
      .where(
        and(
          eq(invoiceScans.businessId, businessId),
          eq(invoiceScans.accountId, accountId),
        ),
      );
    if (open >= MAX_OPEN_SCANS_PER_ACCOUNT) {
      throw new AppException(ErrorCode.INVOICE_SCAN_LIMIT, {
        max: MAX_OPEN_SCANS_PER_ACCOUNT,
      });
    }

    const [scan] = await this.db
      .insert(invoiceScans)
      .values({
        id: generateId(),
        businessId,
        accountId,
        updatedById: accountId,
        ...header(data),
        state: data.state,
        rowCount: data.rowCount,
        pageCount: data.pageCount,
        createdProductIds: [...new Set(data.createdProductIds)],
      })
      .returning();
    return this.toView(scan, accountId);
  }

  /**
   * The autosave: the whole review, last write wins — except the products it
   * made, which are merged. Someone else's save must not make a discard
   * forget a product that one of them created.
   */
  async save(
    businessId: string,
    accountId: string,
    scanId: string,
    data: ScanWrite,
  ): Promise<{updatedAt: Date}> {
    const incoming = JSON.stringify([...new Set(data.createdProductIds)]);
    const [updated] = await this.db
      .update(invoiceScans)
      .set({
        ...header(data),
        state: data.state,
        rowCount: data.rowCount,
        pageCount: data.pageCount,
        createdProductIds: sql`(
          SELECT coalesce(jsonb_agg(DISTINCT e), '[]'::jsonb)
          FROM jsonb_array_elements(${invoiceScans.createdProductIds} || ${incoming}::jsonb) AS e
        )`,
        updatedById: accountId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invoiceScans.id, scanId),
          eq(invoiceScans.businessId, businessId),
        ),
      )
      .returning({updatedAt: invoiceScans.updatedAt});
    if (!updated) throw new AppException(ErrorCode.INVOICE_SCAN_NOT_FOUND);
    return updated;
  }

  /** The products this scan made, and whether each can still be removed. */
  async createdProducts(
    businessId: string,
    scanId: string,
  ): Promise<ScanProductView[]> {
    const scan = await this.find(businessId, scanId);
    return this.classify(businessId, scan);
  }

  /**
   * Finish a scan: its rows went to the receipt, or it was thrown away. With
   * `deleteProducts`, the products it made go too — only the ones nothing has
   * touched since (see `classify`); the rest are reported back and kept.
   */
  async remove(
    businessId: string,
    scanId: string,
    deleteProducts: boolean,
  ): Promise<{deletedProducts: number; keptProducts: number}> {
    const scan = await this.find(businessId, scanId);

    let deletedProducts = 0;
    let keptProducts = 0;
    if (deleteProducts && scan.createdProductIds.length > 0) {
      const views = await this.classify(businessId, scan);
      const doomed = views.filter((v) => v.deletable).map((v) => v.id);
      keptProducts = views.filter(
        (v) => !v.deletable && v.reason !== 'deleted',
      ).length;
      if (doomed.length > 0) {
        // Soft delete, same as DELETE /products/:id. Re-checked in the WHERE so
        // a sale rung up since `classify` ran leaves its product alone.
        const res = await this.db
          .update(products)
          .set({isActive: false, updatedAt: new Date()})
          .where(
            and(
              eq(products.businessId, businessId),
              inArray(products.id, doomed),
              eq(products.isActive, true),
              eq(products.quantity, 0),
            ),
          )
          .returning({id: products.id});
        deletedProducts = res.length;
        keptProducts += doomed.length - res.length;
      }
    }

    await this.db.delete(invoiceScans).where(eq(invoiceScans.id, scan.id));
    return {deletedProducts, keptProducts};
  }

  /** Sweep scans nobody has touched in a while. */
  @Cron('30 4 * * *', {name: 'invoice-scan-sweep', timeZone: 'Asia/Tashkent'})
  async sweepAbandoned(): Promise<void> {
    const cutoff = new Date(Date.now() - ABANDONED_AFTER_DAYS * 86_400_000);
    const stale = await this.db
      .delete(invoiceScans)
      .where(lt(invoiceScans.updatedAt, cutoff))
      .returning({id: invoiceScans.id});
    if (stale.length > 0) {
      this.logger.log(`Swept ${stale.length} abandoned invoice scan(s)`);
    }
  }

  /**
   * A product made for this scan is removable only while it is exactly what
   * the scan left: still active, no stock, never sold, on no receipt (a draft
   * included — deleting it would break that draft) and holding no batch. The
   * product must also be younger than the scan, so an id smuggled into the
   * autosave can't reach an older catalogue item.
   */
  private async classify(
    businessId: string,
    scan: ScanHead,
  ): Promise<ScanProductView[]> {
    const ids = scan.createdProductIds;
    if (ids.length === 0) return [];

    const rows = await this.db
      .select({
        id: products.id,
        name: products.name,
        barcode: products.barcode,
        quantity: products.quantity,
        isActive: products.isActive,
      })
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          inArray(products.id, ids),
          gte(products.createdAt, scan.createdAt),
        ),
      );
    if (rows.length === 0) return [];
    const found = rows.map((r) => r.id);

    const [sold, received, batched] = await Promise.all([
      this.db
        .selectDistinct({id: orderItems.productId})
        .from(orderItems)
        .where(inArray(orderItems.productId, found)),
      this.db
        .selectDistinct({id: goodsReceiptItems.productId})
        .from(goodsReceiptItems)
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            inArray(goodsReceiptItems.productId, found),
          ),
        ),
      this.db
        .selectDistinct({id: inventoryBatches.productId})
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.businessId, businessId),
            inArray(inventoryBatches.productId, found),
          ),
        ),
    ]);
    const soldSet = new Set(sold.map((r) => r.id));
    const receivedSet = new Set(received.map((r) => r.id));
    const batchedSet = new Set(batched.map((r) => r.id));

    return rows.map((r) => {
      const reason: KeepReason | null = !r.isActive
        ? 'deleted'
        : soldSet.has(r.id)
          ? 'sold'
          : receivedSet.has(r.id)
            ? 'received'
            : r.quantity !== 0 || batchedSet.has(r.id)
              ? 'stock'
              : null;
      return {
        id: r.id,
        name: r.name,
        barcode: r.barcode,
        deletable: reason === null,
        reason,
      };
    });
  }

  /** A scan of this shop, whoever started it. */
  private async find(businessId: string, scanId: string): Promise<InvoiceScan> {
    const [scan] = await this.db
      .select()
      .from(invoiceScans)
      .where(
        and(
          eq(invoiceScans.id, scanId),
          eq(invoiceScans.businessId, businessId),
        ),
      )
      .limit(1);
    if (!scan) throw new AppException(ErrorCode.INVOICE_SCAN_NOT_FOUND);
    return scan;
  }

  private async toView(
    scan: InvoiceScan,
    accountId: string,
  ): Promise<InvoiceScanView> {
    const names = await this.accountNames([scan]);
    return {
      ...toSummary(scan, accountId, names),
      state: scan.state ?? null,
      createdProductIds: scan.createdProductIds,
    };
  }

  /**
   * Display names for the accounts that started or last saved these scans:
   * a staff member's name, or the business name for the owner (whose account
   * id is the business id) — the same rule receipts use for the cashier.
   * Looked up live rather than snapshotted: a scan lives for days, not years.
   */
  private async accountNames(scans: ScanHead[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        scans.flatMap((s) => [s.accountId, s.updatedById]).filter(Boolean),
      ),
    ] as string[];
    const names = new Map<string, string>();
    if (ids.length === 0) return names;

    const [staffRows, ownerRows] = await Promise.all([
      this.db
        .select({id: staff.id, name: staff.name})
        .from(staff)
        .where(inArray(staff.id, ids)),
      this.db
        .select({id: businesses.id, name: businesses.name})
        .from(businesses)
        .where(inArray(businesses.id, ids)),
    ]);
    for (const r of [...staffRows, ...ownerRows]) {
      if (r.name) names.set(r.id, r.name);
    }
    return names;
  }
}

/** The note's header, clipped to its columns; absent fields become null. */
function header(data: ScanWrite) {
  return {
    supplierName: data.supplierName?.slice(0, 255) ?? null,
    documentNumber: data.documentNumber?.slice(0, 100) ?? null,
    documentDate: data.documentDate?.slice(0, 10) ?? null,
  };
}

function toSummary(
  s: ScanHead,
  accountId: string,
  names: Map<string, string>,
): InvoiceScanSummary {
  return {
    id: s.id,
    rowCount: s.rowCount,
    pageCount: s.pageCount,
    createdProductCount: s.createdProductIds.length,
    supplierName: s.supplierName,
    documentNumber: s.documentNumber,
    documentDate: s.documentDate,
    createdByName: names.get(s.accountId) ?? null,
    updatedByName: s.updatedById ? (names.get(s.updatedById) ?? null) : null,
    mine: s.accountId === accountId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

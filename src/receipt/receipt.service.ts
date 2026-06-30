import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  goodsReceipts,
  goodsReceiptItems,
  inventoryBatches,
  products,
  suppliers,
  receiptSettings,
  type GoodsReceipt,
  type GoodsReceiptItem,
} from '../database/schema';
import { eq, and, asc, desc, gt, gte, lte, sql } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { CreateReceiptDto } from './dto/create-receipt.dto';

function money(value: number): string {
  return value.toFixed(2);
}

export type ReceiptWithItems = GoodsReceipt & { items: GoodsReceiptItem[] };

@Injectable()
export class ReceiptService {
  constructor(private readonly dbService: DatabaseService) {}

  /**
   * Create a goods receipt: insert the document + items, increment product
   * stock, and roll each product's purchase cost into a weighted average — all
   * in one transaction. Receipts are immutable once created.
   */
  async create(
    businessId: string,
    dto: CreateReceiptDto,
  ): Promise<ReceiptWithItems> {
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
        throw new BadRequestException(`Supplier not found: ${dto.supplierId}`);
      }
      supplierName = supplier.name;
    }

    // Default selling-price behaviour comes from the business settings, but a
    // receipt line can override it per product.
    const [settings] = await this.dbService.db
      .select({ priceIncreaseMode: receiptSettings.priceIncreaseMode })
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);
    const repriceExistingDefault =
      settings?.priceIncreaseMode === 'REPRICE_EXISTING';

    // Validate + snapshot each product once (products may repeat across lines).
    // The receipt keeps every entered line as the document of record.
    const productInfo = new Map<
      string,
      { name: string; priceOut: string; repriceOverride?: boolean }
    >();
    // Per-product received totals — the same product across multiple lines is
    // summed so a single stock/cost update applies the full received batch
    // (otherwise a second line for the same product would overwrite the first).
    const received = new Map<string, { qty: number; value: number }>();
    const lines: {
      itemId: string;
      productId: string;
      productName: string;
      priceIn: string;
      priceOut: string;
      quantity: number;
      lineTotal: string;
    }[] = [];
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
          throw new BadRequestException(`Product not found: ${item.productId}`);
        }
        info = { name: product.name, priceOut: product.priceOut };
        productInfo.set(item.productId, info);
      }
      // A per-line override (last one wins) controls repricing for the product.
      if (item.repriceExisting !== undefined) {
        info.repriceOverride = item.repriceExisting;
      }

      // Selling price of this batch: explicit, else the product's current price.
      const priceOut = item.priceOut ?? Number(info.priceOut);
      const lineTotal = item.priceIn * item.quantity;
      total += lineTotal;
      itemCount += item.quantity;

      lines.push({
        itemId: generateId(),
        productId: item.productId,
        productName: info.name,
        priceIn: money(item.priceIn),
        priceOut: money(priceOut),
        quantity: item.quantity,
        lineTotal: money(lineTotal),
      });

      const agg = received.get(item.productId) ?? { qty: 0, value: 0 };
      agg.qty += item.quantity;
      agg.value += lineTotal;
      received.set(item.productId, agg);
    }

    const receiptId = generateId();

    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(goodsReceipts).values({
        id: receiptId,
        businessId,
        supplierId: dto.supplierId ?? null,
        supplierName,
        status: 'Completed',
        totalAmount: money(total),
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
          quantity: line.quantity,
          lineTotal: line.lineTotal,
        })),
      );

      // Open one inventory batch per line — the FIFO/cost source of truth. Same
      // product at different prices stays as separate lots.
      await tx.insert(inventoryBatches).values(
        lines.map((line) => ({
          id: generateId(),
          businessId,
          productId: line.productId,
          receiptItemId: line.itemId,
          priceIn: line.priceIn,
          priceOut: line.priceOut,
          qtyReceived: line.quantity,
          qtyRemaining: line.quantity,
        })),
      );

      // One atomic update per product: add the received quantity and roll the
      // purchase cost into a weighted average, computed in SQL against the
      // live row so concurrent sales/receipts can't clobber the result.
      // newPriceIn = (oldQty*oldCost + receivedValue) / (oldQty + receivedQty)
      for (const [productId, agg] of received) {
        await tx
          .update(products)
          .set({
            quantity: sql`${products.quantity} + ${agg.qty}`,
            priceIn: sql`CASE WHEN ${products.quantity} + ${agg.qty} > 0
              THEN ROUND(
                (${products.quantity} * ${products.priceIn} + ${money(agg.value)})
                / (${products.quantity} + ${agg.qty}),
                2
              )
              ELSE ${products.priceIn} END`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, productId),
            ),
          );
      }

      // Selling-price handling per product. When the new batch price is higher
      // than the current price, either bump every open batch up to it
      // (REPRICE_EXISTING) or leave old batches at their old price (KEEP_OLD).
      // In all cases products.priceOut tracks the FIFO-front (next-to-sell) price.
      for (const [productId, info] of productInfo) {
        const currentPriceOut = Number(info.priceOut);
        const newPriceOut = Math.max(
          ...lines
            .filter((l) => l.productId === productId)
            .map((l) => Number(l.priceOut)),
        );
        const reprice = info.repriceOverride ?? repriceExistingDefault;

        if (newPriceOut > currentPriceOut && reprice) {
          await tx
            .update(inventoryBatches)
            .set({ priceOut: money(newPriceOut) })
            .where(
              and(
                eq(inventoryBatches.businessId, businessId),
                eq(inventoryBatches.productId, productId),
                gt(inventoryBatches.qtyRemaining, 0),
              ),
            );
          await tx
            .update(products)
            .set({ priceOut: money(newPriceOut), updatedAt: new Date() })
            .where(
              and(
                eq(products.businessId, businessId),
                eq(products.id, productId),
              ),
            );
        } else {
          // Track the oldest open batch's price as the displayed/next price.
          const [front] = await tx
            .select({ priceOut: inventoryBatches.priceOut })
            .from(inventoryBatches)
            .where(
              and(
                eq(inventoryBatches.businessId, businessId),
                eq(inventoryBatches.productId, productId),
                gt(inventoryBatches.qtyRemaining, 0),
              ),
            )
            .orderBy(asc(inventoryBatches.createdAt))
            .limit(1);
          if (front) {
            await tx
              .update(products)
              .set({ priceOut: front.priceOut, updatedAt: new Date() })
              .where(
                and(
                  eq(products.businessId, businessId),
                  eq(products.id, productId),
                ),
              );
          }
        }
      }
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      supplierId?: string;
      startDate?: string;
      endDate?: string;
    },
  ): Promise<{
    receipts: GoodsReceipt[];
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
    if (options?.startDate) {
      whereConditions.push(
        gte(goodsReceipts.createdAt, new Date(options.startDate)),
      );
    }
    if (options?.endDate) {
      whereConditions.push(
        lte(goodsReceipts.createdAt, new Date(options.endDate)),
      );
    }

    const all = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(and(...whereConditions));
    const total = all.length;

    const paginated = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(and(...whereConditions))
      .orderBy(desc(goodsReceipts.createdAt))
      .limit(limit)
      .offset(offset);

    return { receipts: paginated, total, page, limit };
  }

  async findOne(
    businessId: string,
    receiptId: string,
  ): Promise<ReceiptWithItems | null> {
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

    if (!receipt) {
      return null;
    }

    const items = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));

    return { ...receipt, items };
  }
}

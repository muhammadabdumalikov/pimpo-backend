import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  goodsReceipts,
  goodsReceiptItems,
  products,
  suppliers,
  type GoodsReceipt,
  type GoodsReceiptItem,
} from '../database/schema';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
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

    // Validate + snapshot each product's name once (products may repeat across
    // lines). The receipt keeps every entered line as the document of record.
    const productNames = new Map<string, string>();
    // Per-product received totals — the same product across multiple lines is
    // summed so a single stock/cost update applies the full received batch
    // (otherwise a second line for the same product would overwrite the first).
    const received = new Map<string, { qty: number; value: number }>();
    const lines: {
      productId: string;
      productName: string;
      priceIn: string;
      quantity: number;
      lineTotal: string;
    }[] = [];
    let total = 0;
    let itemCount = 0;

    for (const item of dto.items) {
      let name = productNames.get(item.productId);
      if (name === undefined) {
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
        name = product.name;
        productNames.set(item.productId, name);
      }

      const lineTotal = item.priceIn * item.quantity;
      total += lineTotal;
      itemCount += item.quantity;

      lines.push({
        productId: item.productId,
        productName: name,
        priceIn: money(item.priceIn),
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
          id: generateId(),
          receiptId,
          businessId,
          productId: line.productId,
          productName: line.productName,
          priceIn: line.priceIn,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
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

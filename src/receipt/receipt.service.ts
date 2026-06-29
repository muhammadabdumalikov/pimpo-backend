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
import { eq, and, desc, gte, lte } from 'drizzle-orm';
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

    // Load + snapshot each product, compute totals and the new average cost.
    const lines: {
      productId: string;
      productName: string;
      priceIn: string;
      quantity: number;
      lineTotal: string;
      newQuantity: number;
      newPriceIn: string;
    }[] = [];
    let total = 0;
    let itemCount = 0;

    for (const item of dto.items) {
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

      const lineTotal = item.priceIn * item.quantity;
      total += lineTotal;
      itemCount += item.quantity;

      // Weighted-average cost: (oldQty*oldCost + recvQty*recvCost) / totalQty.
      const oldQty = product.quantity;
      const oldCost = Number(product.priceIn);
      const newQuantity = oldQty + item.quantity;
      const newPriceIn =
        newQuantity > 0
          ? (oldQty * oldCost + item.quantity * item.priceIn) / newQuantity
          : item.priceIn;

      lines.push({
        productId: product.id,
        productName: product.name,
        priceIn: money(item.priceIn),
        quantity: item.quantity,
        lineTotal: money(lineTotal),
        newQuantity,
        newPriceIn: money(newPriceIn),
      });
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

      // Increment stock and update the weighted-average cost per product.
      for (const line of lines) {
        await tx
          .update(products)
          .set({
            quantity: line.newQuantity,
            priceIn: line.newPriceIn,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, line.productId),
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

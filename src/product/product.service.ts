import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { products, type Product, type NewProduct } from '../database/schema';
import { eq, and, desc, ilike, or } from 'drizzle-orm';
import { generateId } from '../utils/uuid';

@Injectable()
export class ProductService {
  constructor(private readonly dbService: DatabaseService) {}

  async create(businessId: string, data: {
    name: string;
    code?: string;
    barcode?: string;
    priceIn: string;
    priceOut: string;
    quantity: number;
    quantityType?: string;
    image?: string;
    categoryId?: string;
  }): Promise<Product> {
    // Check if code already exists for this business
    if (data.code) {
      const existing = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.code, data.code),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        throw new ConflictException('Product with this code already exists');
      }
    }

    const newProduct: NewProduct = {
      id: generateId(),
      businessId,
      name: data.name,
      code: data.code || null,
      barcode: data.barcode || null,
      priceIn: data.priceIn,
      priceOut: data.priceOut,
      quantity: data.quantity,
      quantityType: data.quantityType || null,
      image: data.image || null,
      categoryId: data.categoryId || null,
      isActive: true,
    };

    const [product] = await this.dbService.db
      .insert(products)
      .values(newProduct)
      .returning();

    return product;
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
    },
  ): Promise<{ products: Product[]; total: number; page: number; limit: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;
    const search = options?.search;

    // Build where conditions
    const whereConditions = [
      eq(products.businessId, businessId),
      eq(products.isActive, true),
    ];

    if (search) {
      whereConditions.push(
        or(
          ilike(products.name, `%${search}%`),
          ilike(products.code, `%${search}%`),
          ilike(products.barcode, `%${search}%`),
        )!,
      );
    }

    // Get total count
    const allProducts = await this.dbService.db
      .select()
      .from(products)
      .where(and(...whereConditions));
    const total = allProducts.length;

    // Get paginated results
    const paginatedProducts = await this.dbService.db
      .select()
      .from(products)
      .where(and(...whereConditions))
      .orderBy(desc(products.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      products: paginatedProducts,
      total,
      page,
      limit,
    };
  }

  async findOne(businessId: string, productId: string): Promise<Product | null> {
    const [product] = await this.dbService.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.id, productId),
          eq(products.businessId, businessId),
          eq(products.isActive, true),
        ),
      )
      .limit(1);

    return product || null;
  }

  async update(
    businessId: string,
    productId: string,
    data: Partial<Omit<NewProduct, 'id' | 'businessId' | 'createdAt'>>,
  ): Promise<Product> {
    const existing = await this.findOne(businessId, productId);
    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    // Check if code already exists for another product
    if (data.code && data.code !== existing.code) {
      const codeExists = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.code, data.code),
            eq(products.isActive, true),
          ),
        )
        .limit(1);

      if (codeExists.length > 0) {
        throw new ConflictException('Product with this code already exists');
      }
    }

    const [product] = await this.dbService.db
      .update(products)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(products.id, productId),
          eq(products.businessId, businessId),
        ),
      )
      .returning();

    return product;
  }

  async remove(businessId: string, productId: string): Promise<void> {
    const existing = await this.findOne(businessId, productId);
    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    // Soft delete
    await this.dbService.db
      .update(products)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(products.id, productId),
          eq(products.businessId, businessId),
        ),
      );
  }

  async getCount(businessId: string): Promise<number> {
    const result = await this.dbService.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.isActive, true),
        ),
      );

    return result.length;
  }

  async generateProductCode(businessId: string): Promise<string> {
    // Get the count of products for this business
    const productCount = await this.getCount(businessId);
    
    // Generate code pattern: PRD-0001, PRD-0002, etc.
    let attempt = 0;
    const maxAttempts = 1000; // Prevent infinite loop
    
    while (attempt < maxAttempts) {
      const codeNumber = productCount + attempt + 1;
      const generatedCode = `PRD-${String(codeNumber).padStart(4, '0')}`;
      
      // Check if this code already exists
      const existing = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.code, generatedCode),
            eq(products.isActive, true),
          ),
        )
        .limit(1);
      
      if (existing.length === 0) {
        return generatedCode;
      }
      
      attempt++;
    }
    
    // Fallback: use timestamp-based code if all sequential codes are taken
    const timestamp = Date.now().toString().slice(-8);
    return `PRD-${timestamp}`;
  }
}

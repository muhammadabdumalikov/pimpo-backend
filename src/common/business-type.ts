import {eq} from 'drizzle-orm';
import {businesses} from '../database/schema';
import {DatabaseService} from '../database/database.service';

// What kind of business this is (businesses.business_type, FASTFOOD.md §1).
// 'food' unlocks dishes, recipes, the queue number and the kitchen ticket;
// everything else about the two is shared.
export const BUSINESS_TYPES = ['retail', 'food'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export function isBusinessType(value: unknown): value is BusinessType {
  return BUSINESS_TYPES.includes(value as BusinessType);
}

// What a product card is (products.kind, FASTFOOD.md §2). Only a food business
// creates dish/semi cards; every retail product is 'stock'.
export const PRODUCT_KINDS = ['stock', 'dish', 'semi'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export function isProductKind(value: unknown): value is ProductKind {
  return PRODUCT_KINDS.includes(value as ProductKind);
}

/** A card that holds no stock of its own and is made from a recipe. */
export function hasRecipe(kind: string | null | undefined): boolean {
  return kind === 'dish' || kind === 'semi';
}

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The business's type; 'retail' when the row is missing. */
export async function getBusinessType(
  db: Db | Tx,
  businessId: string,
): Promise<BusinessType> {
  const [row] = await db
    .select({businessType: businesses.businessType})
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return row?.businessType === 'food' ? 'food' : 'retail';
}

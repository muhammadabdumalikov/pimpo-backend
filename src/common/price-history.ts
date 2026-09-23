import {DatabaseService} from '../database/database.service';
import {productPriceHistory} from '../database/schema';
import {generateId} from '../utils/uuid';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** The three card fields a price change can touch. */
const PRICE_FIELDS = ['priceOut', 'priceWholesale', 'priceBundle'] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

/** Where a change came from, and the document behind it when there is one. */
export interface PriceChangeOrigin {
  source: 'card' | 'receipt';
  receiptId?: string | null;
}

export interface PriceChangeInput {
  businessId: string;
  productId: string;
  /** The card as it stands now. */
  before: Partial<Record<PriceField, string | null>>;
  /** The fields being written; anything absent is not a change. */
  after: Partial<Record<PriceField, string | null>>;
  origin: PriceChangeOrigin;
  actor: {id: string | null; name: string | null};
}

/** Money carries two decimals: below half a tiyin is the same price. */
function differs(a: string | null | undefined, b: string | null | undefined) {
  if (b == null) return false; // not part of this edit
  if (a == null) return true; // first time this tier is priced
  return Math.abs(Number(a) - Number(b)) > 0.005;
}

/**
 * Write one row per selling price this edit actually moves.
 *
 * Runs inside the caller's transaction, so the history cannot exist without the
 * change it describes — and cannot be missing from one either.
 */
export async function recordPriceChangesTx(
  tx: Tx,
  input: PriceChangeInput,
): Promise<void> {
  const rows = PRICE_FIELDS.filter((f) =>
    differs(input.before[f], input.after[f]),
  ).map((field) => ({
    id: generateId(),
    businessId: input.businessId,
    productId: input.productId,
    field,
    oldPrice: input.before[field] ?? null,
    newPrice: input.after[field] as string,
    source: input.origin.source,
    receiptId: input.origin.receiptId ?? null,
    cashierId: input.actor.id,
    cashierName: input.actor.name,
  }));
  if (rows.length === 0) return;
  await tx.insert(productPriceHistory).values(rows);
}

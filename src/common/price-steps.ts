// "Navbatdagi narx" — a delivery's lower selling price that waits for the stock
// received before it to sell out (product_price_steps).
//
// Why it exists: the card is the one price every unit sells at, so a delivery
// at 2 200 used to put the whole shelf at 2 200 — including the units bought
// earlier for 2 700, which then sold at a loss. Pricing each lot on its own was
// tried before and rejected (the card flip-flopped between lot figures and a
// hand-set price survived only until the next sale). This keeps the card as
// the single price at any moment and moves it once, forward, at the moment the
// older stock is gone.
//
// The rules, settled with the owner (2026-10-06):
// - A rise goes onto the card at once and clears the waiting chain: older
//   stock selling dearer is not a loss.
// - A drop waits until no open lot older than the delivery's own lots is left
//   in ANY branch (the card is global).
// - Several drops chain: each delivery's goods sell at that delivery's price.
//   A delivery between the card and the end of the chain lifts the cheaper
//   waiting steps to its own price (they are "older goods selling dearer").
// - A delivery naming the card's own price is no decision at all — the form
//   pre-fills the line from the card — so it leaves the chain alone.
// - Any other write of a field (a hand edit, apply-now) drops its steps.

import {and, asc, eq, inArray, notExists, sql, gt, lt} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  inventoryBatches,
  productPriceHistory,
  productPriceSteps,
  products,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {recordPriceChangesTx, type PriceField} from './price-history';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

export const PRICE_FIELDS: readonly PriceField[] = [
  'priceOut',
  'priceWholesale',
  'priceBundle',
];

/** Money carries two decimals: below half a tiyin is the same price. */
const EPS = 0.005;

export interface PendingStep {
  id: string;
  price: number;
}

/**
 * What one delivery's figure does to one price field.
 *
 * 'none'  — nothing to do: no figure, the card's own figure, or the figure the
 *           chain already ends on.
 * 'now'   — write it on the card and drop every waiting step of the field.
 * 'queue' — wait. `lift` are the waiting steps it replaces (cheaper ones that
 *           now sell at this figure); the new step takes over the trigger of
 *           the first of them, or the delivery's own when there are none.
 */
export type StepPlan =
  | {kind: 'none'}
  | {kind: 'now'}
  | {kind: 'queue'; lift: string[]};

/**
 * Pure: decide what a delivery's figure does to a field.
 *
 * `steps` are the field's waiting steps in chain order (oldest trigger first);
 * their prices fall as the chain goes on, all below the card. `olderStock`
 * says whether any open lot older than the delivery's own lots is left —
 * without it there is nothing to protect and a drop goes on at once.
 */
export function planPrice(input: {
  card: number | null;
  steps: PendingStep[];
  proposed: number | null;
  defer: boolean;
  olderStock: boolean;
}): StepPlan {
  const {card, steps, proposed} = input;
  if (proposed == null || !(proposed > 0)) return {kind: 'none'};
  // First price for this tier: nothing on the shelf is priced at anything yet.
  if (card == null || !(card > 0)) return {kind: 'now'};
  if (Math.abs(proposed - card) <= EPS) return {kind: 'none'};
  if (proposed > card) return {kind: 'now'};

  const end = steps.length > 0 ? steps[steps.length - 1].price : card;
  if (Math.abs(proposed - end) <= EPS) return {kind: 'none'};
  if (!input.defer || !input.olderStock) return {kind: 'now'};

  return {
    kind: 'queue',
    lift: steps.filter((s) => s.price <= proposed + EPS).map((s) => s.id),
  };
}

/** A waiting step that just took effect. */
export interface AppliedPriceStep {
  productId: string;
  productName: string;
  field: PriceField;
  from: string | null;
  to: string;
  receiptId: string;
}

/**
 * The instant before which a lot counts as "older stock" for this delivery:
 * its own earliest lot of the product, cut to the millisecond (lots moved
 * between branches carry their createdAt through a JS Date). SQL only — no
 * Date ever crosses the driver.
 */
function receiptTriggerSql(receiptId: string, productId: string) {
  return sql`(select date_trunc('milliseconds', min(b.created_at))
    from inventory_batches b
    join goods_receipt_items i on i.id = b.receipt_item_id
    where i.receipt_id = ${receiptId} and b.product_id = ${productId})`;
}

/** Is any open lot of the product older than this delivery's own lots? */
export async function hasOlderStockTx(
  tx: Tx,
  businessId: string,
  productId: string,
  receiptId: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    select exists (
      select 1 from inventory_batches o
      where o.business_id = ${businessId}
        and o.product_id = ${productId}
        and o.qty_remaining > 0
        and o.created_at < ${receiptTriggerSql(receiptId, productId)}
    ) as older`);
  // db.execute() returns a bare row array or a { rows } object depending on
  // the driver path — read both.
  const rows =
    (res as {rows?: Array<{older: boolean}>}).rows ??
    (res as unknown as Array<{older: boolean}>);
  return Boolean(rows[0]?.older);
}

/**
 * Of these products, the ones with open lots older than this delivery's own —
 * where a drop on this delivery would wait. One query for a whole receipt.
 */
export async function productsWithOlderStock(
  db: Pick<DatabaseService['db'], 'execute'>,
  businessId: string,
  receiptId: string,
  productIds: string[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const ids = sql.join(
    productIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const res = await db.execute(sql`
    select distinct o.product_id
    from inventory_batches o
    where o.business_id = ${businessId}
      and o.product_id in (${ids})
      and o.qty_remaining > 0
      and o.created_at < (
        select date_trunc('milliseconds', min(b.created_at))
        from inventory_batches b
        join goods_receipt_items i on i.id = b.receipt_item_id
        where i.receipt_id = ${receiptId} and b.product_id = o.product_id)`);
  const rows =
    (res as {rows?: Array<{product_id: string}>}).rows ??
    (res as unknown as Array<{product_id: string}>);
  return new Set(rows.map((r) => r.product_id));
}

/** The field's waiting steps in chain order, locked for this transaction. */
export async function pendingStepsTx(
  tx: Tx,
  businessId: string,
  productId: string,
  field: PriceField,
): Promise<PendingStep[]> {
  const rows = await tx
    .select({id: productPriceSteps.id, price: productPriceSteps.price})
    .from(productPriceSteps)
    .where(
      and(
        eq(productPriceSteps.businessId, businessId),
        eq(productPriceSteps.productId, productId),
        eq(productPriceSteps.field, field),
      ),
    )
    .orderBy(asc(productPriceSteps.triggerAt), asc(productPriceSteps.createdAt))
    .for('update');
  return rows.map((r) => ({id: r.id, price: Number(r.price)}));
}

/**
 * Put a planned 'queue' in the chain: the new step takes the trigger of the
 * first step it lifts (those goods now sell at its price), or the delivery's
 * own when it lifts none; the lifted steps go.
 */
export async function queueStepTx(
  tx: Tx,
  input: {
    businessId: string;
    productId: string;
    field: PriceField;
    price: string;
    receiptId: string;
    lift: string[];
    actor: {id: string | null; name: string | null};
    /** The card's figure for the field right now — the price that keeps
     *  selling while this one waits. */
    cardPrice: string | null;
  },
): Promise<void> {
  const id = generateId();
  const trigger =
    input.lift.length > 0
      ? sql`(select trigger_at from product_price_steps where id = ${input.lift[0]})`
      : receiptTriggerSql(input.receiptId, input.productId);
  const res = await tx.execute(sql`
    insert into product_price_steps
      (id, business_id, product_id, field, price, receipt_id, trigger_at,
       cashier_id, cashier_name)
    select ${id}, ${input.businessId}, ${input.productId}, ${input.field},
           ${input.price}::numeric, ${input.receiptId}, t.at,
           ${input.actor.id}, ${input.actor.name}
    from (select ${trigger} as at) t
    where t.at is not null
    returning id`);
  const inserted =
    (res as {rows?: Array<{id: string}>}).rows ??
    (res as unknown as Array<{id: string}>);
  // The moment it joined the queue, on the record: "2 200 waits, 2 700 keeps
  // selling". Not a shelf move — old_price is the card's figure that stays.
  if (inserted.length > 0) {
    await tx.insert(productPriceHistory).values({
      id: generateId(),
      businessId: input.businessId,
      productId: input.productId,
      field: input.field,
      oldPrice: input.cardPrice,
      newPrice: input.price,
      source: 'queue_add',
      receiptId: input.receiptId,
      cashierId: input.actor.id,
      cashierName: input.actor.name,
    });
  }
  if (input.lift.length > 0) {
    await dropStepsTx(
      tx,
      and(
        eq(productPriceSteps.businessId, input.businessId),
        inArray(productPriceSteps.id, input.lift),
      ),
      {reason: 'replaced', actor: input.actor},
    );
  }
}

/**
 * Why a waiting price was dropped before it took effect — written on its
 * 'queue_cancel' history row, so "where did my 2 200 go?" has an answer.
 *
 * 'card'      — the price was set by hand on the card.
 * 'button'    — "Bekor qilish" on the product card.
 * 'receipt'   — a delivery's price went onto the card (a rise, or a drop with
 *               nothing older left to protect).
 * 'replaced'  — a dearer delivery took its place in the chain.
 * 'unreceive' — its delivery was taken back.
 * 'overtaken' — a step further down the chain took effect in the same move
 *               (the stock behind both ran out at once, or "apply now" was
 *               pressed on the later one), so the card went past it.
 */
export type StepCancelReason =
  | 'card'
  | 'button'
  | 'receipt'
  | 'replaced'
  | 'unreceive'
  | 'overtaken';

export interface StepCancelContext {
  reason: StepCancelReason;
  actor: {id: string | null; name: string | null};
}

/**
 * Drop the waiting steps `where` selects and leave one 'queue_cancel' history
 * row per step: new_price is the figure that will now never reach the card,
 * receipt_id the delivery it came from. Returns how many went.
 */
async function dropStepsTx(
  tx: Tx,
  where: ReturnType<typeof and>,
  ctx: StepCancelContext,
): Promise<number> {
  const gone = await tx.delete(productPriceSteps).where(where).returning({
    businessId: productPriceSteps.businessId,
    productId: productPriceSteps.productId,
    field: productPriceSteps.field,
    price: productPriceSteps.price,
    receiptId: productPriceSteps.receiptId,
  });
  if (gone.length === 0) return 0;
  await tx.insert(productPriceHistory).values(
    gone.map((g) => ({
      id: generateId(),
      businessId: g.businessId,
      productId: g.productId,
      field: g.field,
      oldPrice: null,
      newPrice: g.price,
      source: 'queue_cancel',
      reason: ctx.reason,
      receiptId: g.receiptId,
      cashierId: ctx.actor.id,
      cashierName: ctx.actor.name,
    })),
  );
  return gone.length;
}

/** Drop the waiting steps of these fields — a price was written another way. */
export async function cancelPriceStepsTx(
  tx: Tx,
  businessId: string,
  productId: string,
  fields: readonly PriceField[],
  ctx: StepCancelContext,
): Promise<void> {
  if (fields.length === 0) return;
  await dropStepsTx(
    tx,
    and(
      eq(productPriceSteps.businessId, businessId),
      eq(productPriceSteps.productId, productId),
      inArray(productPriceSteps.field, [...fields]),
    ),
    ctx,
  );
}

/** "Bekor qilish": one waiting price, or every one of the product's. */
export async function cancelProductStepsTx(
  tx: Tx,
  businessId: string,
  productId: string,
  stepId: string | undefined,
  ctx: StepCancelContext,
): Promise<number> {
  return dropStepsTx(
    tx,
    and(
      eq(productPriceSteps.businessId, businessId),
      eq(productPriceSteps.productId, productId),
      ...(stepId ? [eq(productPriceSteps.id, stepId)] : []),
    ),
    ctx,
  );
}

/** A delivery was taken back: the prices that waited on its lots go too. */
export async function cancelReceiptStepsTx(
  tx: Tx,
  businessId: string,
  receiptId: string,
  ctx: StepCancelContext,
): Promise<void> {
  await dropStepsTx(
    tx,
    and(
      eq(productPriceSteps.businessId, businessId),
      eq(productPriceSteps.receiptId, receiptId),
    ),
    ctx,
  );
}

/**
 * Write the given steps' prices on the cards and drop them — plus every step
 * ahead of them in their chain, which they overtake. Per product and field the
 * last given step (chain order) is the price that stands. One history row per
 * moved field, sourced 'queued', naming whoever queued the step (or `actor`,
 * when a person pressed "apply now").
 */
async function applyStepsTx(
  tx: Tx,
  businessId: string,
  due: {
    id: string;
    productId: string;
    field: string;
    price: string;
    receiptId: string;
    cashierId: string | null;
    cashierName: string | null;
  }[],
  actor?: {id: string | null; name: string | null},
): Promise<AppliedPriceStep[]> {
  if (due.length === 0) return [];

  // Chain order is the input order; the last one per product+field wins.
  const last = new Map<string, (typeof due)[number]>();
  for (const s of due) last.set(`${s.productId}|${s.field}`, s);

  const productIds = [...new Set(due.map((s) => s.productId))];
  const cards = await tx
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
        inArray(products.id, productIds),
      ),
    )
    .for('update');
  const cardById = new Map(cards.map((c) => [c.id, c]));

  const applied: AppliedPriceStep[] = [];
  for (const productId of productIds) {
    const card = cardById.get(productId);
    if (!card) continue;
    const set: Record<string, string | Date> = {};
    const after: Partial<Record<PriceField, string>> = {};
    let receiptId = '';
    let by = actor ?? null;
    for (const field of PRICE_FIELDS) {
      const step = last.get(`${productId}|${field}`);
      if (!step) continue;
      const from = card[field];
      if (from != null && Math.abs(Number(from) - Number(step.price)) <= EPS) {
        continue;
      }
      set[field] = step.price;
      after[field] = step.price;
      receiptId = step.receiptId;
      by ??= {id: step.cashierId, name: step.cashierName};
      applied.push({
        productId,
        productName: card.name,
        field,
        from,
        to: step.price,
        receiptId: step.receiptId,
      });
    }
    if (Object.keys(after).length === 0) continue;
    set.updatedAt = new Date();
    await tx
      .update(products)
      .set(set)
      .where(
        and(eq(products.businessId, businessId), eq(products.id, productId)),
      );
    await recordPriceChangesTx(tx, {
      businessId,
      productId,
      before: {
        priceOut: card.priceOut,
        priceWholesale: card.priceWholesale,
        priceBundle: card.priceBundle,
      },
      after,
      origin: {source: 'queued', receiptId},
      actor: by ?? {id: null, name: null},
    });
  }

  // Steps the card went past in the same move never reached it: say so, so
  // their delivery's record does not end on "waiting" for ever.
  const lastIds = new Set([...last.values()].map((s) => s.id));
  const overtaken = due.filter((s) => !lastIds.has(s.id));
  if (overtaken.length > 0) {
    await tx.insert(productPriceHistory).values(
      overtaken.map((s) => ({
        id: generateId(),
        businessId,
        productId: s.productId,
        field: s.field,
        oldPrice: null,
        newPrice: s.price,
        source: 'queue_cancel',
        reason: 'overtaken',
        receiptId: s.receiptId,
        cashierId: actor?.id ?? null,
        cashierName: actor?.name ?? null,
      })),
    );
  }

  await tx.delete(productPriceSteps).where(
    inArray(
      productPriceSteps.id,
      due.map((s) => s.id),
    ),
  );
  return applied;
}

/**
 * History rows that are NOT the shelf price moving: a delivery line corrected
 * to the card ('receipt_line'), a waiting price joining the queue
 * ('queue_add') or dropped from it ('queue_cancel'). Anything that counts,
 * filters or reasons about price changes must leave them out.
 */
export const NON_SHELF_SOURCES = [
  'receipt_line',
  'queue_add',
  'queue_cancel',
] as const;

const STEP_COLUMNS = {
  id: productPriceSteps.id,
  productId: productPriceSteps.productId,
  field: productPriceSteps.field,
  price: productPriceSteps.price,
  receiptId: productPriceSteps.receiptId,
  cashierId: productPriceSteps.cashierId,
  cashierName: productPriceSteps.cashierName,
};

/**
 * Apply every waiting step whose older stock is gone — no open lot created
 * before its trigger in any branch. `productIds` narrows the check to the
 * products just sold/moved; omitted, the whole business is checked.
 */
export async function settleDuePriceStepsTx(
  tx: Tx,
  businessId: string,
  productIds?: string[],
): Promise<AppliedPriceStep[]> {
  if (productIds && productIds.length === 0) return [];
  const due = await tx
    .select(STEP_COLUMNS)
    .from(productPriceSteps)
    .where(
      and(
        eq(productPriceSteps.businessId, businessId),
        ...(productIds
          ? [inArray(productPriceSteps.productId, productIds)]
          : []),
        notExists(
          tx
            .select({one: sql`1`})
            .from(inventoryBatches)
            .where(
              and(
                eq(inventoryBatches.businessId, productPriceSteps.businessId),
                eq(inventoryBatches.productId, productPriceSteps.productId),
                gt(inventoryBatches.qtyRemaining, 0),
                lt(inventoryBatches.createdAt, productPriceSteps.triggerAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      asc(productPriceSteps.productId),
      asc(productPriceSteps.field),
      asc(productPriceSteps.triggerAt),
      asc(productPriceSteps.createdAt),
    )
    .for('update', {skipLocked: true});
  return applyStepsTx(tx, businessId, due);
}

/**
 * "Apply now" on the product card: this step and every step ahead of it in
 * its chain take effect at once. Returns null when the step is gone (already
 * applied or cancelled).
 */
export async function applyStepNowTx(
  tx: Tx,
  businessId: string,
  productId: string,
  stepId: string,
  actor: {id: string | null; name: string | null},
): Promise<AppliedPriceStep[] | null> {
  const [target] = await tx
    .select({field: productPriceSteps.field})
    .from(productPriceSteps)
    .where(
      and(
        eq(productPriceSteps.businessId, businessId),
        eq(productPriceSteps.productId, productId),
        eq(productPriceSteps.id, stepId),
      ),
    )
    .limit(1);
  if (!target) return null;
  const chain = await tx
    .select(STEP_COLUMNS)
    .from(productPriceSteps)
    .where(
      and(
        eq(productPriceSteps.businessId, businessId),
        eq(productPriceSteps.productId, productId),
        eq(productPriceSteps.field, target.field),
      ),
    )
    .orderBy(asc(productPriceSteps.triggerAt), asc(productPriceSteps.createdAt))
    .for('update');
  const upTo = chain.findIndex((s) => s.id === stepId);
  if (upTo < 0) return null;
  return applyStepsTx(tx, businessId, chain.slice(0, upTo + 1), actor);
}

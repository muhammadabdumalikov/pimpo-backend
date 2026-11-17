import {sql, SQL} from 'drizzle-orm';
import type {
  OnboardingFacts,
  OnboardingRequiredStepKey,
  OnboardingStepKey,
} from './onboarding.steps';

/**
 * The one definition of each checklist condition, shared by the shop's own
 * card (GET /onboarding, one business) and the platform console's setup column
 * (every listed business at once), so the two cannot drift.
 *
 * Every condition takes `bid`, the SQL for the business id: a bound value on
 * the single-shop path, `BUSINESS_ID_COLUMN` when correlated on the outer
 * businesses row. Each is an EXISTS that stops at the first matching row and
 * leads with business_id on an index (noted per line).
 */

/** Steps answered by a query; the storefront step is read off the row. */
export type QueriedStep = Exclude<OnboardingStepKey, 'store'>;

/**
 * `"businesses"."id"`, spelled out. Drizzle prints `${businesses.id}` bare
 * ("id") in a select without joins, which inside these subqueries would bind
 * to the inner table's own id — silently wrong.
 */
export const BUSINESS_ID_COLUMN = sql`"businesses"."id"`;

export const STEP_EXISTS: Record<QueriedStep, (bid: SQL) => SQL> = {
  // products_business_created_idx (business_id, … WHERE is_active).
  product: (bid) => sql`EXISTS (
    SELECT 1 FROM products p
    WHERE p.business_id = ${bid} AND p.is_active
  )`,
  // Same index; quantity mirrors SUM(branch_stock) for the business.
  stock: (bid) => sql`EXISTS (
    SELECT 1 FROM products p
    WHERE p.business_id = ${bid} AND p.is_active AND p.quantity > 0
  )`,
  // 'Completed' is the only status every sales report counts: Held baskets
  // are till drafts, Pending/Awaiting/Assembling/… are storefront or
  // hand-made online orders still in progress, Cancelled never sold. A
  // completed online order is 'Completed' too. drizzle/0112_onboarding.sql
  // backfills with this same condition — keep the two in step.
  // orders_business_created_idx (business_id, created_at, id).
  sale: (bid) => sql`EXISTS (
    SELECT 1 FROM orders o
    WHERE o.business_id = ${bid} AND o.status = 'Completed'
  )`,
  // Only an account holder can sign in (staff.has_account); a payroll-only
  // employee is not "staff added" for the till. staff has no business_id
  // index, but the table holds a handful of rows per shop.
  staff: (bid) => sql`EXISTS (
    SELECT 1 FROM staff s
    WHERE s.business_id = ${bid} AND s.is_active AND s.has_account
  )`,
  // The same test TelegramNotifyService.listActiveChatIds uses to decide
  // where notifications go: any active linked chat, owner or staff.
  // telegram_links_business_idx (business_id).
  telegram: (bid) => sql`EXISTS (
    SELECT 1 FROM telegram_links t
    WHERE t.business_id = ${bid} AND t.is_active
  )`,
};

/**
 * A kitchen's first product is something the till can sell — a dish, or a
 * stock card shown on the menu (a can of cola) — not a raw ingredient.
 * products_business_created_idx.
 */
const FOOD_PRODUCT_EXISTS = (bid: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM products p
  WHERE p.business_id = ${bid} AND p.is_active
    AND (p.kind = 'dish' OR (p.kind = 'stock' AND p.show_in_menu))
)`;

/** The condition for `step` as it applies to a business of `businessType`. */
export function stepExists(
  step: QueriedStep,
  businessType: string | null | undefined,
): (bid: SQL) => SQL {
  if (step === 'product' && businessType === 'food') return FOOD_PRODUCT_EXISTS;
  return STEP_EXISTS[step];
}

/** The storefront step: switched on and given an address. Free — on the row. */
export function storeFact(row: {
  storeEnabled: boolean | null;
  storeSlug: string | null;
}): boolean {
  return !!row.storeEnabled && !!row.storeSlug;
}

/**
 * Select-list columns for the required queried steps of the businesses row
 * being selected, correlated on `"businesses"."id"` — for the platform list,
 * so the facts ride on the query that already reads the rows (no extra round
 * trip, and only the listed shops are probed).
 *
 * The step list depends on the business type, so each column is a CASE that
 * picks the condition `stepExists` would pick for that row's type, and skips
 * the probe (false) where the type has no such step. Postgres evaluates only
 * the chosen branch's subplan. The type tests mirror `onboardingStepsFor`
 * (unknown types read as retail).
 */
export function requiredFactColumns(): Record<
  Exclude<OnboardingRequiredStepKey, 'store'>,
  SQL<boolean>
> {
  const type = sql`"businesses"."business_type"`;
  const bid = BUSINESS_ID_COLUMN;
  return {
    product: sql<boolean>`CASE WHEN ${type} = 'food'
      THEN ${stepExists('product', 'food')(bid)}
      ELSE ${stepExists('product', 'retail')(bid)} END`,
    // Only retail (and unknown types) has a stock step.
    stock: sql<boolean>`CASE WHEN ${type} IN ('food', 'online')
      THEN false
      ELSE ${stepExists('stock', 'retail')(bid)} END`,
    sale: sql<boolean>`${stepExists('sale', null)(bid)}`,
  };
}

/** Facts from a row that carries `requiredFactColumns()` and the store flags. */
export function requiredFactsFromRow(row: {
  product: unknown;
  stock: unknown;
  sale: unknown;
  storeEnabled: boolean | null;
  storeSlug: string | null;
}): OnboardingFacts {
  return {
    product: row.product === true,
    stock: row.stock === true,
    store: storeFact(row),
    sale: row.sale === true,
  };
}

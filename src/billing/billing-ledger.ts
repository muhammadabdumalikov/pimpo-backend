import {eq, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {billingProfiles, billingTransactions} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {generateId} from '../utils/uuid';
import {settlement} from './ai-usage';

export type Tx = Parameters<
  Parameters<DatabaseService['db']['transaction']>[0]
>[0];

export type BillingTransactionType =
  | 'topup'
  | 'renewal'
  | 'plan_change'
  | 'branch'
  | 'addon'
  | 'ai_usage'
  | 'adjustment';

/** What a ledger line may explain (OBUNA-TOLOV.md §3); shown to the shop. */
export interface BillingTransactionMeta {
  planTier?: string;
  planName?: string;
  fromPlanName?: string;
  periodStart?: string;
  periodEnd?: string;
  extraBranches?: number;
  discountPercent?: number;
  /** So'm the discounts took off this charge (all kinds together). */
  discountAmount?: number;
  days?: number;
  branchName?: string;
  /** Old lines only: the AI bot add-on of 0109, gone since 0125. */
  aiAddon?: number;
  /** An 'ai_usage' line: how many bot answers it pays for. */
  aiAnswers?: number;
  /** 'year' on a yearly renewal (OBUNA-TOLOV.md §9); absent = a month. */
  cycle?: 'month' | 'year';
  /** So'm the yearly price saved against twelve months. */
  yearlyDiscount?: number;
}

/** Two decimals, as numeric(14,2) stores them — no float dust in the ledger. */
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * Lock the business's billing_profiles row for the rest of the transaction,
 * creating it first when missing, and return the balance. Every balance move
 * and every subscription write takes this lock, so they run one at a time per
 * business — two app instances renewing at once, or a renewal racing a topup,
 * serialise here.
 */
export async function lockBillingProfile(
  tx: Tx,
  businessId: string,
): Promise<number> {
  await tx.insert(billingProfiles).values({businessId}).onConflictDoNothing();
  const [row] = await tx
    .select({balance: billingProfiles.balance})
    .from(billingProfiles)
    .where(eq(billingProfiles.businessId, businessId))
    .for('update');
  return Number(row?.balance ?? 0);
}

/**
 * Move the balance by `amount` (signed) and append the matching ledger line,
 * inside the caller's transaction. Refuses to take the balance below zero —
 * no charge and no adjustment may do that.
 */
export async function postBillingTransaction(
  tx: Tx,
  businessId: string,
  entry: {
    type: BillingTransactionType;
    amount: number;
    meta?: BillingTransactionMeta;
    internalNote?: string | null;
    createdBy: string;
    paymentRequestId?: string | null;
  },
): Promise<{id: string; balanceAfter: number}> {
  const balance = await lockBillingProfile(tx, businessId);
  const amount = money(entry.amount);
  const balanceAfter = money(balance + amount);
  if (balanceAfter < 0) {
    throw new AppException(ErrorCode.BILLING_INSUFFICIENT_BALANCE, {
      required: -amount,
      balance,
      shortfall: money(-balanceAfter),
    });
  }

  const now = new Date();
  await tx
    .update(billingProfiles)
    .set({balance: balanceAfter.toFixed(2), updatedAt: now})
    .where(eq(billingProfiles.businessId, businessId));

  const id = generateId();
  await tx.insert(billingTransactions).values({
    id,
    businessId,
    type: entry.type,
    amount: amount.toFixed(2),
    balanceAfter: balanceAfter.toFixed(2),
    meta: entry.meta ?? {},
    internalNote: entry.internalNote ?? null,
    createdBy: entry.createdBy,
    paymentRequestId: entry.paymentRequestId ?? null,
    createdAt: now,
  });
  return {id, balanceAfter};
}

/**
 * Take the bot answers accrued so far from the balance as one 'ai_usage' line
 * (ai-usage.ts settlement: whole so'm, never below `reserve`, so never below
 * zero). Runs inside the caller's transaction and takes the profile lock, like
 * every balance move. Returns what was taken, or null when there was nothing
 * to take.
 */
export async function settleAiUsage(
  tx: Tx,
  businessId: string,
  reserve = 0,
): Promise<{amount: number; answers: number; balanceAfter: number} | null> {
  const balance = await lockBillingProfile(tx, businessId);
  const [row] = await tx
    .select({
      unbilled: billingProfiles.aiUnbilled,
      answers: billingProfiles.aiUnbilledAnswers,
    })
    .from(billingProfiles)
    .where(eq(billingProfiles.businessId, businessId));
  const take = settlement({
    unsettled: Number(row?.unbilled ?? 0),
    answers: row?.answers ?? 0,
    balance,
    reserve,
  });
  if (take.amount <= 0) return null;

  const posted = await postBillingTransaction(tx, businessId, {
    type: 'ai_usage',
    amount: -take.amount,
    meta: {aiAnswers: take.answers},
    createdBy: 'system',
  });
  await tx
    .update(billingProfiles)
    .set({
      aiUnbilled: sql`${billingProfiles.aiUnbilled} - ${take.amount.toFixed(2)}::numeric`,
      aiUnbilledAnswers: sql`${billingProfiles.aiUnbilledAnswers} - ${take.answers}`,
    })
    .where(eq(billingProfiles.businessId, businessId));
  return {...take, balanceAfter: posted.balanceAfter};
}

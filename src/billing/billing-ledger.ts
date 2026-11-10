import {eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {billingProfiles, billingTransactions} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {generateId} from '../utils/uuid';

export type Tx = Parameters<
  Parameters<DatabaseService['db']['transaction']>[0]
>[0];

export type BillingTransactionType =
  | 'topup'
  | 'renewal'
  | 'plan_change'
  | 'branch'
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
  days?: number;
  branchName?: string;
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

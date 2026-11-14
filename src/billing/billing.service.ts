import {Inject, Injectable, Logger} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  billingProfiles,
  billingTransactions,
  branches,
  businessSubscriptions,
  businesses,
  paymentRequests,
  platformSettings,
  staff,
  subscriptionDiscounts,
  subscriptionPlans,
  type BillingProfile,
  type BusinessSubscription,
  type PaymentRequest,
  type SubscriptionPlan,
} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {CacheKeys, TTL} from '../cache/cache.util';
import {IAccount, IBusiness} from '../business/types';
import {PermissionService} from '../permission/permission.service';
import {SubscriptionService} from '../subscription/subscription.service';
import {TelegramNotifyService} from '../telegram/telegram-notify.service';
import {generateId} from '../utils/uuid';
import {isBusinessType} from '../common/business-type';
import {sellsAiAddon} from '../subscription/tier';
import type {AiAddonView} from '../subscription/subscription.service';
import {
  AI_ADDON_PRICE,
  GRACE_DAYS,
  asDate,
  classifyPlanChange,
  computeBillingStage,
  computeMonthlyTotal,
  graceEndsAt,
  isPastEnd,
  nextPeriod,
  periodDays,
  prorate,
  tashkentDaysBetween,
  type BillingStage,
  type DiscountTerm,
  type MonthlyTotal,
  type PlanChangeCase,
} from './billing';
import {
  lockBillingProfile,
  postBillingTransaction,
  type BillingTransactionMeta,
  type BillingTransactionType,
  type Tx,
} from './billing-ledger';
import {
  billingRenewedText,
  paymentRequestedText,
  tashkentDate,
} from './billing-text';
import type {PaymentRequestFilter} from './dto/billing.dto';

const DAY_MS = 86_400_000;
// A rejection stays on the shop's screen this long (§6.1 lastRejected).
const REJECTION_VISIBLE_MS = 7 * DAY_MS;
const REQUISITES_KEY = 'payment_requisites';
// Where a billing push/inbox tap lands.
const SUBSCRIPTION_URL = '/subscription-management';

// ─── API shapes (OBUNA-TOLOV.md §6 — the frontend is written against these) ──

export interface PaymentRequisites {
  cardNumber: string | null;
  cardHolder: string | null;
  bankName: string | null;
  accountNumber: string | null;
  mfo: string | null;
  recipientName: string | null;
  inn: string | null;
  note: string | null;
}

const REQUISITE_FIELDS: (keyof PaymentRequisites)[] = [
  'cardNumber',
  'cardHolder',
  'bankName',
  'accountNumber',
  'mfo',
  'recipientName',
  'inn',
  'note',
];

export interface PendingRequestView {
  id: string;
  amount: number;
  comment: string | null;
  createdAt: string;
}

export interface LastRejected {
  reason: string | null;
  resolvedAt: string;
}

export interface BillingStatus {
  stage: BillingStage;
  isTrial: boolean;
  planTier: string | null;
  planName: string | null;
  endDate: string | null;
  daysLeft: number | null;
  graceEndsAt: string | null;
  graceDaysLeft: number | null;
  paymentPending: boolean;
  canPay: boolean;
  pay: null | {
    amountDue: number;
    monthlyTotal: number;
    balance: number;
    lastRejected: LastRejected | null;
  };
}

export interface PaymentInfo {
  amountDue: number;
  monthlyTotal: number;
  balance: number;
  requisites: PaymentRequisites;
  pendingRequest: PendingRequestView | null;
  lastRejected: LastRejected | null;
}

export interface BillingTransactionView {
  id: string;
  type: BillingTransactionType;
  amount: number;
  balanceAfter: number;
  createdAt: string;
  meta: BillingTransactionMeta;
}

export interface PlanChangePreview {
  direction: 'upgrade' | 'downgrade' | 'same';
  mode: 'immediate' | 'scheduled';
  charge: number;
  daysRemaining: number;
  balance: number;
  shortfall: number;
  effectiveAt: string | null;
  newMonthlyTotal: number;
}

export interface BranchBillingPreview {
  chargeable: boolean;
  charge: number;
  monthlyPrice: number;
  daysRemaining: number;
  balance: number;
  shortfall: number;
}

export interface PlatformPaymentRequest {
  id: string;
  businessId: string;
  businessName: string;
  amount: number;
  comment: string | null;
  requestedByName: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejectReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  balance: number;
  amountDue: number;
}

/** The billing column of the platform businesses list (§6.2). */
export interface PlatformBillingSummary {
  stage: BillingStage | 'open_ended';
  amountDue: number;
  isTrial: boolean;
  paymentPending: boolean;
}

/** GET /mobile/home → attention.subscription (§6.1). */
export interface AiAddonPreview {
  /** Taken from the balance now (0 when it is free, see aiAddonQuote). */
  charge: number;
  daysRemaining: number;
  balance: number;
  shortfall: number;
  monthlyPrice: number;
}

export interface BillingAttention {
  endDate: string | null;
  daysLeft: number | null;
  stage: BillingStage;
  isTrial: boolean;
  graceDaysLeft: number | null;
  paymentPending: boolean;
}

// ─── Internals ───────────────────────────────────────────────────────────────

type ActiveSubscription = BusinessSubscription & {plan: SubscriptionPlan};

/** Everything a billing decision reads, loaded inside one transaction. */
interface BillingContext {
  balance: number;
  sub: ActiveSubscription | null;
  activeBranches: number;
  extraBranches: number;
  /**
   * The shop's active discount rows. Which of them hold depends on the plan
   * being priced (a special price is tied to one plan), so they are resolved
   * per plan in monthlyFor(), not once here.
   */
  discounts: DiscountTerm[];
  /** The owner keeps the AI bot add-on for the next period (E4). */
  aiAddonWanted: boolean;
  now: Date;
}

/** The discount columns the rules read (billing.ts DiscountTerm). */
const DISCOUNT_TERM_COLUMNS = {
  id: subscriptionDiscounts.id,
  label: subscriptionDiscounts.label,
  kind: subscriptionDiscounts.kind,
  scope: subscriptionDiscounts.scope,
  percent: subscriptionDiscounts.percent,
  amount: subscriptionDiscounts.amount,
  planTier: subscriptionDiscounts.planTier,
  validUntil: subscriptionDiscounts.validUntil,
};

/** What a month on `plan` costs this shop, with its discounts. */
function monthlyFor(
  ctx: Pick<BillingContext, 'discounts' | 'aiAddonWanted' | 'now'>,
  plan: {tier: string; price: string | number} | null,
  extraBranches: number,
): MonthlyTotal {
  return computeMonthlyTotal({
    planPrice: plan ? Number(plan.price) : 0,
    planTier: plan?.tier ?? null,
    extraBranches,
    // Billed only on the plan that sells it: a shop moved off the online
    // plan stops paying for it even if the flag is still on.
    aiAddon: ctx.aiAddonWanted && sellsAiAddon(plan?.tier),
    discounts: ctx.discounts,
    now: ctx.now,
  });
}

/** What the next renewal will charge and what the shop is short of it. */
interface Quote {
  sub: ActiveSubscription | null;
  balance: number;
  renewalTotal: number;
  amountDue: number;
}

/** Cached request state; dates as ISO strings so a Redis round-trip is lossless. */
interface RequestState {
  pending: PendingRequestView | null;
  latestRejected: LastRejected | null;
}

/**
 * Subscription billing (OBUNA-TOLOV.md): the balance ledger, the renewal
 * engine, the shop's billing status / payment requests / plan and branch
 * charges, and the platform console's side of it.
 *
 * Every balance move goes through postBillingTransaction inside a transaction
 * that holds the business's billing_profiles row lock (billing-ledger.ts).
 * Every write here also re-reads the subscription under that lock, so the
 * decisions are made on fresh rows, not on the (cached) ones a preview showed.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly subscriptions: SubscriptionService,
    private readonly permissions: PermissionService,
    private readonly telegram: TelegramNotifyService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ─── Context / quote ──────────────────────────────────────────────────────

  private async loadContext(
    tx: Tx,
    businessId: string,
    now: Date,
    lock: boolean,
  ): Promise<BillingContext> {
    let balance: number;
    if (lock) {
      balance = await lockBillingProfile(tx, businessId);
    } else {
      const [row] = await tx
        .select({balance: billingProfiles.balance})
        .from(billingProfiles)
        .where(eq(billingProfiles.businessId, businessId));
      balance = Number(row?.balance ?? 0);
    }

    // Sequential on purpose: one transaction is one connection.
    const [subRow] = await tx
      .select({sub: businessSubscriptions, plan: subscriptionPlans})
      .from(businessSubscriptions)
      .innerJoin(
        subscriptionPlans,
        eq(businessSubscriptions.planId, subscriptionPlans.id),
      )
      .where(
        and(
          eq(businessSubscriptions.businessId, businessId),
          eq(businessSubscriptions.isActive, true),
        ),
      )
      .orderBy(desc(businessSubscriptions.createdAt))
      .limit(1);
    const [{value: activeBranches}] = await tx
      .select({value: count()})
      .from(branches)
      .where(
        and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
      );
    // Oldest first: the order the breakdown lists them in.
    const discounts = await tx
      .select(DISCOUNT_TERM_COLUMNS)
      .from(subscriptionDiscounts)
      .where(
        and(
          eq(subscriptionDiscounts.businessId, businessId),
          eq(subscriptionDiscounts.isActive, true),
        ),
      )
      .orderBy(asc(subscriptionDiscounts.createdAt));

    const [profile] = await tx
      .select({aiAddon: billingProfiles.aiAddon})
      .from(billingProfiles)
      .where(eq(billingProfiles.businessId, businessId));

    const active = Number(activeBranches);
    return {
      balance,
      aiAddonWanted: !!profile?.aiAddon,
      sub: subRow ? {...subRow.sub, plan: subRow.plan} : null,
      activeBranches: active,
      extraBranches: Math.max(0, active - 1),
      discounts,
      now,
    };
  }

  /** Read-only context for previews (no lock). */
  private readContext(businessId: string, now: Date): Promise<BillingContext> {
    return this.db.transaction((tx) =>
      this.loadContext(tx, businessId, now, false),
    );
  }

  /**
   * From the cached subscription + billing views (hot path: every page polls
   * the status). The renewal charges the scheduled plan when there is one, so
   * that is what "enough balance" is measured against.
   */
  private async quote(businessId: string): Promise<Quote> {
    const [sub, billing] = await Promise.all([
      this.subscriptions.getBusinessSubscription(businessId),
      this.subscriptions.getBillingInfo(businessId),
    ]);
    let renewalTotal = billing.monthly.total;
    if (sub?.pendingPlanId) {
      const pending = await this.subscriptions.getPlanById(sub.pendingPlanId);
      if (pending) {
        // Re-priced from the rows, not from the current plan's percent: a
        // discount tied to the current plan does not follow the shop down.
        renewalTotal = computeMonthlyTotal({
          planPrice: Number(pending.price),
          planTier: pending.tier,
          extraBranches: billing.monthly.extraBranches,
          aiAddon: billing.monthly.aiAddon > 0 && sellsAiAddon(pending.tier),
          discounts: billing.discounts,
        }).total;
      }
    }
    return {
      sub,
      balance: billing.balance,
      renewalTotal,
      amountDue: Math.max(0, renewalTotal - billing.balance),
    };
  }

  private async requestState(businessId: string): Promise<RequestState> {
    return this.cache.wrap(
      CacheKeys.billingRequests(businessId),
      async () => {
        // At most one pending at a time and nothing newer can be filed while
        // it waits, so the latest request is the pending one when there is one.
        const [latest] = await this.db
          .select()
          .from(paymentRequests)
          .where(eq(paymentRequests.businessId, businessId))
          .orderBy(desc(paymentRequests.createdAt))
          .limit(1);
        return {
          pending:
            latest?.status === 'pending' ? this.pendingView(latest) : null,
          latestRejected:
            latest?.status === 'rejected' && latest.resolvedAt
              ? {
                  reason: latest.rejectReason,
                  resolvedAt: asDate(latest.resolvedAt).toISOString(),
                }
              : null,
        };
      },
      TTL.SUBSCRIPTION,
    );
  }

  private recentRejection(state: RequestState, now: Date): LastRejected | null {
    const r = state.latestRejected;
    if (!r) return null;
    return now.getTime() - asDate(r.resolvedAt).getTime() <=
      REJECTION_VISIBLE_MS
      ? r
      : null;
  }

  private pendingView(r: PaymentRequest): PendingRequestView {
    return {
      id: r.id,
      amount: Number(r.amount),
      comment: r.comment,
      createdAt: asDate(r.createdAt).toISOString(),
    };
  }

  /** Drop every cached view a balance or subscription change touches. */
  private async invalidate(
    businessId: string,
    requests = false,
  ): Promise<void> {
    await this.subscriptions.invalidate(businessId);
    if (requests) await this.cache.del(CacheKeys.billingRequests(businessId));
  }

  // ─── Shop: status / payment info / requests / history ────────────────────

  private async statusCore(businessId: string, now: Date) {
    const [q, requests] = await Promise.all([
      this.quote(businessId),
      this.requestState(businessId),
    ]);
    const sub = q.sub;
    const endDate = sub?.endDate ? asDate(sub.endDate) : null;
    const stage: BillingStage = sub
      ? computeBillingStage({
          endDate,
          balance: q.balance,
          amountNeeded: q.renewalTotal,
          now,
        })
      : 'none';
    const graceEnd = stage === 'grace' && endDate ? graceEndsAt(endDate) : null;
    return {
      q,
      requests,
      stage,
      endDate,
      daysLeft:
        endDate && !isPastEnd(endDate, now)
          ? tashkentDaysBetween(now, endDate)
          : null,
      graceEnd,
      graceDaysLeft: graceEnd
        ? Math.max(0, tashkentDaysBetween(now, graceEnd))
        : null,
    };
  }

  /** GET /subscriptions/billing-status — any staff; amounts only for payers. */
  async getBillingStatus(
    businessId: string,
    account: IAccount,
  ): Promise<BillingStatus> {
    const now = new Date();
    const [core, canPay] = await Promise.all([
      this.statusCore(businessId, now),
      this.permissions.can(account, 'settings:manage'),
    ]);
    const sub = core.q.sub;
    return {
      stage: core.stage,
      isTrial: sub?.isTrial ?? false,
      planTier: sub?.plan.tier ?? null,
      planName: sub?.plan.name ?? null,
      endDate: core.endDate?.toISOString() ?? null,
      daysLeft: core.daysLeft,
      graceEndsAt: core.graceEnd?.toISOString() ?? null,
      graceDaysLeft: core.graceDaysLeft,
      paymentPending: !!core.requests.pending,
      canPay,
      pay: canPay
        ? {
            amountDue: core.q.amountDue,
            monthlyTotal: core.q.renewalTotal,
            balance: core.q.balance,
            lastRejected: this.recentRejection(core.requests, now),
          }
        : null,
    };
  }

  /** The phone home's "E'tibor" card; null when there is nothing to show. */
  async getAttention(businessId: string): Promise<BillingAttention | null> {
    const core = await this.statusCore(businessId, new Date());
    if (core.stage === 'none') return null;
    return {
      endDate: core.endDate?.toISOString() ?? null,
      daysLeft: core.daysLeft,
      stage: core.stage,
      isTrial: core.q.sub?.isTrial ?? false,
      graceDaysLeft: core.graceDaysLeft,
      paymentPending: !!core.requests.pending,
    };
  }

  /** GET /subscriptions/payment-info — what to pay, where, and the request state. */
  async getPaymentInfo(businessId: string): Promise<PaymentInfo> {
    const now = new Date();
    const [q, requests, requisites] = await Promise.all([
      this.quote(businessId),
      this.requestState(businessId),
      this.getRequisites(),
    ]);
    return {
      amountDue: q.amountDue,
      monthlyTotal: q.renewalTotal,
      balance: q.balance,
      requisites,
      pendingRequest: requests.pending,
      lastRejected: this.recentRejection(requests, now),
    };
  }

  /** POST /subscriptions/payment-requests — "To'lov qildim". */
  async createPaymentRequest(
    business: IBusiness,
    account: IAccount,
    data: {amount: number; comment?: string},
  ): Promise<PendingRequestView> {
    const businessId = business.id;
    const [pending] = await this.db
      .select({id: paymentRequests.id})
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.businessId, businessId),
          eq(paymentRequests.status, 'pending'),
        ),
      )
      .limit(1);
    if (pending)
      throw new AppException(ErrorCode.PAYMENT_REQUEST_ALREADY_PENDING);

    let requestedByName: string | null = business.name;
    if (account.type === 'staff') {
      const [row] = await this.db
        .select({name: staff.name})
        .from(staff)
        .where(and(eq(staff.id, account.id), eq(staff.businessId, businessId)))
        .limit(1);
      requestedByName = row?.name ?? null;
    }

    const comment = data.comment?.trim() || null;
    let created: PaymentRequest;
    try {
      [created] = await this.db
        .insert(paymentRequests)
        .values({
          id: generateId(),
          businessId,
          amount: data.amount.toFixed(2),
          comment,
          status: 'pending',
          requestedByName,
        })
        .returning();
    } catch (e) {
      // Two presses at once: the partial unique index lets only one through.
      if (isUniqueViolation(e)) {
        throw new AppException(ErrorCode.PAYMENT_REQUEST_ALREADY_PENDING);
      }
      throw e;
    }
    await this.cache.del(CacheKeys.billingRequests(businessId));

    const q = await this.quote(businessId);
    this.telegram.notifyPlatformAdmins(
      paymentRequestedText({
        businessName: business.name,
        amount: data.amount,
        requestedByName,
        comment,
        balance: q.balance,
        amountDue: q.amountDue,
      }),
    );
    return this.pendingView(created);
  }

  /** The ledger, newest first. `internal` adds the platform-only columns. */
  async listTransactions(
    businessId: string,
    opts: {page?: number; limit?: number; internal?: boolean},
  ): Promise<{
    items: (BillingTransactionView & {
      internalNote?: string | null;
      createdBy?: string | null;
    })[];
    total: number;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const where = eq(billingTransactions.businessId, businessId);
    const [rows, [{value: total}]] = await Promise.all([
      this.db
        .select()
        .from(billingTransactions)
        .where(where)
        .orderBy(
          desc(billingTransactions.createdAt),
          desc(billingTransactions.id),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      this.db.select({value: count()}).from(billingTransactions).where(where),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type as BillingTransactionType,
        amount: Number(r.amount),
        balanceAfter: Number(r.balanceAfter),
        createdAt: asDate(r.createdAt).toISOString(),
        meta: (r.meta ?? {}) as BillingTransactionMeta,
        ...(opts.internal && {
          internalNote: r.internalNote,
          createdBy: r.createdBy,
        }),
      })),
      total: Number(total),
    };
  }

  // ─── Renewal engine (§4) ──────────────────────────────────────────────────

  /**
   * Renew a dated subscription whose end_date has passed, if the balance
   * covers the month. Idempotent and safe to call from anywhere at any time:
   * everything is re-checked under the billing_profiles lock, so of two
   * concurrent callers (two cron instances, cron + topup) exactly one renews
   * and the other finds a future end_date and does nothing.
   */
  async tryRenew(
    businessId: string,
    now: Date = new Date(),
  ): Promise<{renewed: boolean}> {
    const result = await this.db.transaction(async (tx) => {
      const ctx = await this.loadContext(tx, businessId, now, true);
      const sub = ctx.sub;
      if (!sub || sub.endDate == null || !isPastEnd(sub.endDate, now))
        return null;

      // A scheduled downgrade takes over here.
      let plan = sub.plan;
      if (sub.pendingPlanId) {
        const [pending] = await tx
          .select()
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.id, sub.pendingPlanId))
          .limit(1);
        if (pending) plan = pending;
      }

      const monthly = monthlyFor(ctx, plan, ctx.extraBranches);
      // No partial charges (Q1): short of the full month, nothing changes.
      if (ctx.balance < monthly.total) return null;

      const period = nextPeriod(sub.endDate, now);
      const posted = await postBillingTransaction(tx, businessId, {
        type: 'renewal',
        amount: -monthly.total,
        meta: {
          planTier: plan.tier,
          planName: plan.name,
          ...(plan.id !== sub.plan.id && {fromPlanName: sub.plan.name}),
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          extraBranches: monthly.extraBranches,
          discountPercent: monthly.discountPercent,
          ...(monthly.aiAddon > 0 && {aiAddon: monthly.aiAddon}),
          ...(monthly.discountAmount > 0 && {
            discountAmount: monthly.discountAmount,
          }),
        },
        createdBy: 'system',
      });

      const closed = await tx
        .update(businessSubscriptions)
        .set({isActive: false, updatedAt: now})
        .where(
          and(
            eq(businessSubscriptions.id, sub.id),
            eq(businessSubscriptions.isActive, true),
          ),
        )
        .returning({id: businessSubscriptions.id});
      if (!closed.length) {
        // Unreachable under the lock; throwing rolls the charge back.
        throw new Error(`subscription ${sub.id} changed during renewal`);
      }
      await tx.insert(businessSubscriptions).values({
        id: generateId(),
        businessId,
        planId: plan.id,
        startDate: period.start,
        endDate: period.end,
        isActive: true,
        isTrial: false,
        pendingPlanId: null,
        paidExtraBranches: monthly.extraBranches,
        // Paid for in this charge, so the bot answers the whole new period.
        aiAddon: monthly.aiAddon > 0,
      });
      return {plan, monthly, period, balanceAfter: posted.balanceAfter};
    });

    if (!result) return {renewed: false};
    await this.invalidate(businessId);

    // Q16: one message per renewal; say now if next month will be short.
    const nextShortfall = Math.max(
      0,
      result.monthly.total - result.balanceAfter,
    );
    this.sendBilling(
      businessId,
      billingRenewedText({
        planName: result.plan.name,
        periodEnd: result.period.end,
        charged: result.monthly.total,
        balanceAfter: result.balanceAfter,
        nextShortfall,
      }),
      {
        kind: 'renewed',
        planName: result.plan.name,
        periodEnd: tashkentDate(result.period.end),
        charged: result.monthly.total,
        balance: result.balanceAfter,
        shortfall: nextShortfall,
      },
    );
    this.logger.log(
      `Renewed ${businessId}: ${result.plan.tier} until ${result.period.end.toISOString()} (−${result.monthly.total})`,
    );
    return {renewed: true};
  }

  /** Fire-and-forget billing notice: Telegram + inbox/push, no toggles. */
  sendBilling(
    businessId: string,
    message: string,
    data: Record<string, unknown>,
  ): void {
    void this.telegram
      .dispatchBilling(businessId, message, {
        event: 'billing',
        data: {...data, url: SUBSCRIPTION_URL},
      })
      .catch((e) =>
        this.logger.warn(
          `billing notice for ${businessId} failed: ${(e as Error).message}`,
        ),
      );
  }

  // ─── Plan change (§5) ─────────────────────────────────────────────────────

  /**
   * The plan a shop may pick for itself: an active, purchasable plan of its
   * own business type. The internal `free` floor never qualifies — a shop must
   * not "downgrade" onto it and then renew at 0 forever.
   */
  private async resolveTargetPlan(
    business: IBusiness,
    tier: string,
  ): Promise<SubscriptionPlan> {
    const plans = await this.subscriptions.getAllPlans(
      isBusinessType(business.businessType) ? business.businessType : 'retail',
    );
    const plan = plans.find(
      (p) => p.tier === tier && p.isActive && p.tier !== 'free',
    );
    if (!plan) {
      throw new AppException(ErrorCode.SUBSCRIPTION_PLAN_TIER_NOT_FOUND, {
        tier,
      });
    }
    return plan;
  }

  private planChangeQuote(
    ctx: BillingContext,
    target: SubscriptionPlan,
    now: Date,
  ): PlanChangePreview & {kind: PlanChangeCase} {
    const sub = ctx.sub;
    const currentPrice = sub ? Number(sub.plan.price) : 0;
    const targetPrice = Number(target.price);
    const {kind, direction} = classifyPlanChange({
      current: sub
        ? {
            planTier: sub.plan.tier,
            planPrice: currentPrice,
            endDate: sub.endDate,
            isTrial: sub.isTrial,
          }
        : null,
      target: {tier: target.tier, price: targetPrice},
      now,
    });
    if (kind === 'managed') {
      throw new AppException(ErrorCode.SUBSCRIPTION_MANAGED_BY_ADMIN);
    }

    const days =
      sub?.endDate != null && !isPastEnd(sub.endDate, now)
        ? periodDays(sub.startDate, sub.endDate, now)
        : {daysRemaining: 0, periodDays: 1};
    // What the shop pays a month on each plan, discounts included — a plan
    // with its own special price is charged by that price, not by the list.
    const currentMonthly = monthlyFor(ctx, sub?.plan ?? null, ctx.extraBranches);
    const targetMonthly = monthlyFor(ctx, target, ctx.extraBranches);
    const charge =
      kind === 'upgrade'
        ? prorate({
            monthlyAmount: targetMonthly.total - currentMonthly.total,
            ...days,
          })
        : 0;

    return {
      kind,
      direction,
      mode: kind === 'downgrade' ? 'scheduled' : 'immediate',
      charge,
      daysRemaining: days.daysRemaining,
      balance: ctx.balance,
      shortfall: Math.max(0, charge - ctx.balance),
      effectiveAt:
        kind === 'downgrade' && sub?.endDate
          ? asDate(sub.endDate).toISOString()
          : null,
      newMonthlyTotal: targetMonthly.total,
    };
  }

  /** GET /subscriptions/change-preview?tier= */
  async previewPlanChange(
    business: IBusiness,
    tier: string,
  ): Promise<PlanChangePreview> {
    const target = await this.resolveTargetPlan(business, tier);
    const now = new Date();
    const ctx = await this.readContext(business.id, now);
    const q = this.planChangeQuote(ctx, target, now);
    return {
      direction: q.direction,
      mode: q.mode,
      charge: q.charge,
      daysRemaining: q.daysRemaining,
      balance: q.balance,
      shortfall: q.shortfall,
      effectiveAt: q.effectiveAt,
      newMonthlyTotal: q.newMonthlyTotal,
    };
  }

  /**
   * PUT /subscriptions/current, POST /subscriptions/subscribe. Never creates
   * an open-ended row: every path leaves a dated subscription (§5).
   */
  async changePlan(business: IBusiness, account: IAccount, tier: string) {
    const businessId = business.id;
    const target = await this.resolveTargetPlan(business, tier);
    const now = new Date();

    const quote = await this.db.transaction(async (tx) => {
      const ctx = await this.loadContext(tx, businessId, now, true);
      const q = this.planChangeQuote(ctx, target, now);
      const sub = ctx.sub;

      switch (q.kind) {
        case 'upgrade':
          if (q.charge > 0) {
            await postBillingTransaction(tx, businessId, {
              type: 'plan_change',
              amount: -q.charge,
              meta: {
                planTier: target.tier,
                planName: target.name,
                fromPlanName: sub!.plan.name,
                days: q.daysRemaining,
                discountPercent: monthlyFor(ctx, target, ctx.extraBranches)
                  .discountPercent,
                periodEnd: asDate(sub!.endDate!).toISOString(),
              },
              createdBy: account.id,
            });
          }
          await this.setPlan(tx, sub!.id, target.id, now);
          break;
        case 'trial':
        case 'same':
        case 'expired':
          // Re-picking the current plan also cancels a scheduled downgrade.
          await this.setPlan(tx, sub!.id, target.id, now);
          break;
        case 'downgrade':
          await tx
            .update(businessSubscriptions)
            .set({pendingPlanId: target.id, updatedAt: now})
            .where(eq(businessSubscriptions.id, sub!.id));
          break;
        case 'fresh': {
          // Dated already past its grace: the renewal below starts the month
          // today, or leaves the shop restricted on the chosen plan until it pays.
          const end = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
          await tx
            .update(businessSubscriptions)
            .set({isActive: false, updatedAt: now})
            .where(
              and(
                eq(businessSubscriptions.businessId, businessId),
                eq(businessSubscriptions.isActive, true),
              ),
            );
          await tx.insert(businessSubscriptions).values({
            id: generateId(),
            businessId,
            planId: target.id,
            startDate: end,
            endDate: end,
            isActive: true,
            isTrial: false,
            paidExtraBranches: ctx.extraBranches,
          });
          break;
        }
      }
      return q;
    });

    await this.invalidate(businessId);
    const renewed =
      quote.kind === 'expired' || quote.kind === 'fresh'
        ? (await this.tryRenew(businessId)).renewed
        : false;

    return {
      mode: quote.mode,
      charged: quote.kind === 'upgrade' ? quote.charge : 0,
      effectiveAt: quote.effectiveAt,
      renewed,
      subscription: await this.subscriptions.getCurrentView(businessId),
    };
  }

  private async setPlan(
    tx: Tx,
    subscriptionId: string,
    planId: string,
    now: Date,
  ) {
    await tx
      .update(businessSubscriptions)
      .set({planId, pendingPlanId: null, updatedAt: now})
      .where(eq(businessSubscriptions.id, subscriptionId));
  }

  // ─── Branch seats (§5, Q13) ───────────────────────────────────────────────

  private branchQuote(
    ctx: BillingContext,
    now: Date,
  ): BranchBillingPreview & {
    extraAfter: number;
  } {
    const sub = ctx.sub;
    // The default branch always exists (created on first use), so the new one
    // is at least the first extra.
    const extraAfter = Math.max(1, ctx.activeBranches);
    const newSeats = Math.max(0, extraAfter - (sub?.paidExtraBranches ?? 0));
    const plan = sub?.plan ?? null;
    const totalWith = (extra: number) => monthlyFor(ctx, plan, extra).total;
    const monthlyPrice = totalWith(extraAfter) - totalWith(extraAfter - 1);

    const running =
      sub?.endDate != null && !sub.isTrial && !isPastEnd(sub.endDate, now);
    const chargeable = running && newSeats > 0;
    const days =
      chargeable && sub?.endDate != null
        ? periodDays(sub.startDate, sub.endDate, now)
        : {daysRemaining: 0, periodDays: 1};
    const charge = chargeable
      ? prorate({
          // What the unpaid seats add to the month, net of any discount that
          // covers branches — 150 000 each when there is none.
          monthlyAmount: totalWith(extraAfter) - totalWith(extraAfter - newSeats),
          ...days,
        })
      : 0;
    return {
      chargeable,
      charge,
      monthlyPrice,
      daysRemaining: days.daysRemaining,
      balance: ctx.balance,
      shortfall: Math.max(0, charge - ctx.balance),
      extraAfter,
    };
  }

  /** GET /branches/billing-preview — what opening one more branch costs now. */
  async previewBranchCharge(businessId: string): Promise<BranchBillingPreview> {
    const now = new Date();
    const ctx = await this.readContext(businessId, now);
    const q = this.branchQuote(ctx, now);
    return {
      chargeable: q.chargeable,
      charge: q.charge,
      monthlyPrice: q.monthlyPrice,
      daysRemaining: q.daysRemaining,
      balance: q.balance,
      shortfall: q.shortfall,
    };
  }

  /**
   * Open a branch, charging its seat for the rest of the period when the shop
   * is on a running paid period and the seat isn't paid yet. `insert` runs in
   * the same transaction, so a refused charge (BILLING_INSUFFICIENT_BALANCE)
   * leaves no branch behind.
   */
  async createBranchWithCharge<T>(
    businessId: string,
    branchName: string,
    createdBy: string,
    insert: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const now = new Date();
    const created = await this.db.transaction(async (tx) => {
      const ctx = await this.loadContext(tx, businessId, now, true);
      const q = this.branchQuote(ctx, now);
      if (q.chargeable && ctx.sub) {
        if (q.charge > 0) {
          await postBillingTransaction(tx, businessId, {
            type: 'branch',
            amount: -q.charge,
            meta: {
              branchName,
              days: q.daysRemaining,
              extraBranches: q.extraAfter,
              periodEnd: asDate(ctx.sub.endDate!).toISOString(),
            },
            createdBy,
          });
        }
        await tx
          .update(businessSubscriptions)
          .set({paidExtraBranches: q.extraAfter, updatedAt: now})
          .where(eq(businessSubscriptions.id, ctx.sub.id));
      }
      return insert(tx);
    });
    await this.invalidate(businessId);
    return created;
  }

  // ─── AI bot add-on (ONLAYN-SOTUVCHI.md E4–E7) ──────────────────────────────

  /**
   * What switching the add-on on costs now: the rest of a running paid
   * period at the list price. Free while it is already part of the period,
   * on the trial, on an admin-granted open-ended plan, and past the end (the
   * renewal then bills it in full).
   */
  private aiAddonQuote(ctx: BillingContext, now: Date): AiAddonPreview {
    const sub = ctx.sub;
    if (!sub || !sellsAiAddon(sub.plan.tier)) {
      throw new AppException(ErrorCode.AI_ADDON_NOT_AVAILABLE);
    }
    const running =
      sub.endDate != null && !sub.isTrial && !isPastEnd(sub.endDate, now);
    const chargeable = running && !sub.aiAddon;
    const days =
      chargeable && sub.endDate != null
        ? periodDays(sub.startDate, sub.endDate, now)
        : {daysRemaining: 0, periodDays: 1};
    const charge = chargeable
      ? prorate({monthlyAmount: AI_ADDON_PRICE, ...days})
      : 0;
    return {
      charge,
      daysRemaining: days.daysRemaining,
      balance: ctx.balance,
      shortfall: Math.max(0, charge - ctx.balance),
      monthlyPrice: AI_ADDON_PRICE,
    };
  }

  /** GET /subscriptions/ai-addon/preview — what turning it on costs now. */
  async previewAiAddon(businessId: string): Promise<AiAddonPreview> {
    const now = new Date();
    return this.aiAddonQuote(await this.readContext(businessId, now), now);
  }

  /**
   * POST /subscriptions/ai-addon. On: charge the rest of the period (refused
   * whole on a short balance), make it part of this period and keep it for
   * the next. Off: only the next renewal drops it — the paid period runs out
   * with the bot still answering, and nothing is refunded (E6).
   */
  async setAiAddon(
    businessId: string,
    enabled: boolean,
    createdBy: string,
  ): Promise<AiAddonView> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const ctx = await this.loadContext(tx, businessId, now, true);
      const sub = ctx.sub;
      if (enabled) {
        const q = this.aiAddonQuote(ctx, now);
        if (q.charge > 0 && sub?.endDate) {
          await postBillingTransaction(tx, businessId, {
            type: 'addon',
            amount: -q.charge,
            meta: {
              aiAddon: AI_ADDON_PRICE,
              days: q.daysRemaining,
              periodEnd: asDate(sub.endDate).toISOString(),
            },
            createdBy,
          });
        }
        if (sub && !sub.aiAddon) {
          await tx
            .update(businessSubscriptions)
            .set({aiAddon: true, updatedAt: now})
            .where(eq(businessSubscriptions.id, sub.id));
        }
      } else if (!sub || !sellsAiAddon(sub.plan.tier)) {
        throw new AppException(ErrorCode.AI_ADDON_NOT_AVAILABLE);
      }
      await tx
        .update(billingProfiles)
        .set({aiAddon: enabled, updatedAt: now})
        .where(eq(billingProfiles.businessId, businessId));
    });
    await this.invalidate(businessId);
    return this.subscriptions.aiAddonView(businessId);
  }

  // ─── Platform ─────────────────────────────────────────────────────────────

  private async profile(businessId: string): Promise<BillingProfile> {
    const [row] = await this.db
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.businessId, businessId))
      .limit(1);
    return row;
  }

  private async assertBusiness(businessId: string): Promise<void> {
    const [row] = await this.db
      .select({id: businesses.id})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
  }

  /** Credit the balance (platform console / legacy admin token), then renew. */
  async topUp(
    businessId: string,
    amount: number,
    note?: string | null,
  ): Promise<BillingProfile> {
    await this.assertBusiness(businessId);
    await this.db.transaction((tx) =>
      postBillingTransaction(tx, businessId, {
        type: 'topup',
        amount,
        internalNote: note ?? null,
        createdBy: 'platform',
      }),
    );
    await this.invalidate(businessId);
    await this.tryRenew(businessId);
    return this.profile(businessId);
  }

  /** Signed correction with a mandatory note; cannot take the balance below 0. */
  async adjust(
    businessId: string,
    amount: number,
    note: string,
  ): Promise<BillingProfile> {
    await this.assertBusiness(businessId);
    await this.db.transaction((tx) =>
      postBillingTransaction(tx, businessId, {
        type: 'adjustment',
        amount,
        internalNote: note,
        createdBy: 'platform',
      }),
    );
    await this.invalidate(businessId);
    await this.tryRenew(businessId);
    return this.profile(businessId);
  }

  async listPaymentRequests(opts: {
    status?: PaymentRequestFilter;
    page?: number;
    limit?: number;
  }): Promise<{
    items: PlatformPaymentRequest[];
    total: number;
    pendingCount: number;
  }> {
    const status = opts.status ?? 'pending';
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const where: SQL | undefined =
      status === 'pending'
        ? eq(paymentRequests.status, 'pending')
        : status === 'resolved'
          ? ne(paymentRequests.status, 'pending')
          : undefined;

    const [rows, [{value: total}], [{value: pendingCount}]] = await Promise.all(
      [
        this.db
          .select({req: paymentRequests, businessName: businesses.name})
          .from(paymentRequests)
          .innerJoin(businesses, eq(paymentRequests.businessId, businesses.id))
          .where(where)
          // The queue oldest first; history newest first.
          .orderBy(
            status === 'pending'
              ? asc(paymentRequests.createdAt)
              : desc(paymentRequests.createdAt),
          )
          .limit(limit)
          .offset((page - 1) * limit),
        this.db.select({value: count()}).from(paymentRequests).where(where),
        this.db
          .select({value: count()})
          .from(paymentRequests)
          .where(eq(paymentRequests.status, 'pending')),
      ],
    );

    const quotes = new Map<string, Quote>();
    for (const id of new Set(rows.map((r) => r.req.businessId))) {
      quotes.set(id, await this.quote(id));
    }
    return {
      items: rows.map((r) =>
        this.platformRequestView(
          r.req,
          r.businessName,
          quotes.get(r.req.businessId)!,
        ),
      ),
      total: Number(total),
      pendingCount: Number(pendingCount),
    };
  }

  private platformRequestView(
    r: PaymentRequest,
    businessName: string,
    q: Quote,
  ): PlatformPaymentRequest {
    return {
      id: r.id,
      businessId: r.businessId,
      businessName,
      amount: Number(r.amount),
      comment: r.comment,
      requestedByName: r.requestedByName,
      status: r.status as PlatformPaymentRequest['status'],
      rejectReason: r.rejectReason,
      createdAt: asDate(r.createdAt).toISOString(),
      resolvedAt: r.resolvedAt ? asDate(r.resolvedAt).toISOString() : null,
      balance: q.balance,
      amountDue: q.amountDue,
    };
  }

  private async platformRequest(id: string): Promise<PlatformPaymentRequest> {
    const [row] = await this.db
      .select({req: paymentRequests, businessName: businesses.name})
      .from(paymentRequests)
      .innerJoin(businesses, eq(paymentRequests.businessId, businesses.id))
      .where(eq(paymentRequests.id, id))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.PAYMENT_REQUEST_NOT_FOUND);
    return this.platformRequestView(
      row.req,
      row.businessName,
      await this.quote(row.req.businessId),
    );
  }

  private async lockPendingRequest(
    tx: Tx,
    id: string,
  ): Promise<PaymentRequest> {
    const [req] = await tx
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, id))
      .for('update');
    if (!req) throw new AppException(ErrorCode.PAYMENT_REQUEST_NOT_FOUND);
    if (req.status !== 'pending') {
      throw new AppException(ErrorCode.PAYMENT_REQUEST_ALREADY_RESOLVED);
    }
    return req;
  }

  /** Approve: credit the received amount (default: the requested one), then renew. */
  async approvePaymentRequest(
    id: string,
    data: {amount?: number; note?: string},
  ): Promise<PlatformPaymentRequest> {
    const businessId = await this.db.transaction(async (tx) => {
      const req = await this.lockPendingRequest(tx, id);
      const posted = await postBillingTransaction(tx, req.businessId, {
        type: 'topup',
        amount: data.amount ?? Number(req.amount),
        internalNote: data.note ?? null,
        createdBy: 'platform',
        paymentRequestId: req.id,
      });
      await tx
        .update(paymentRequests)
        .set({
          status: 'approved',
          resolvedAt: new Date(),
          transactionId: posted.id,
        })
        .where(eq(paymentRequests.id, id));
      return req.businessId;
    });
    await this.invalidate(businessId, true);
    await this.tryRenew(businessId);
    return this.platformRequest(id);
  }

  async rejectPaymentRequest(
    id: string,
    reason: string,
  ): Promise<PlatformPaymentRequest> {
    const businessId = await this.db.transaction(async (tx) => {
      const req = await this.lockPendingRequest(tx, id);
      await tx
        .update(paymentRequests)
        .set({
          status: 'rejected',
          rejectReason: reason.trim(),
          resolvedAt: new Date(),
        })
        .where(eq(paymentRequests.id, id));
      return req.businessId;
    });
    await this.cache.del(CacheKeys.billingRequests(businessId));
    return this.platformRequest(id);
  }

  async getRequisites(): Promise<PaymentRequisites> {
    const [row] = await this.db
      .select({value: platformSettings.value})
      .from(platformSettings)
      .where(eq(platformSettings.key, REQUISITES_KEY))
      .limit(1);
    const stored = (row?.value ?? {}) as Partial<PaymentRequisites>;
    const out = {} as PaymentRequisites;
    for (const f of REQUISITE_FIELDS) {
      const v = stored[f];
      out[f] = typeof v === 'string' && v.trim() ? v : null;
    }
    return out;
  }

  /** Keys left out keep their value; null or "" clears one. */
  async setRequisites(
    patch: Partial<PaymentRequisites>,
  ): Promise<PaymentRequisites> {
    const next = await this.getRequisites();
    for (const f of REQUISITE_FIELDS) {
      if (patch[f] === undefined) continue;
      next[f] = patch[f]?.trim() || null;
    }
    const now = new Date();
    await this.db
      .insert(platformSettings)
      .values({key: REQUISITES_KEY, value: next, updatedAt: now})
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: {value: next, updatedAt: now},
      });
    return next;
  }

  /**
   * The billing column for every business in the platform list, in a fixed
   * handful of queries (not per business).
   */
  async platformSummaries(): Promise<Map<string, PlatformBillingSummary>> {
    const now = new Date();
    const [subs, profiles, branchCounts, discounts, pending] =
      await Promise.all([
        this.db
          .select({
            businessId: businessSubscriptions.businessId,
            endDate: businessSubscriptions.endDate,
            isTrial: businessSubscriptions.isTrial,
            planPrice: subscriptionPlans.price,
            planTier: subscriptionPlans.tier,
            pendingPlanId: businessSubscriptions.pendingPlanId,
            createdAt: businessSubscriptions.createdAt,
          })
          .from(businessSubscriptions)
          .innerJoin(
            subscriptionPlans,
            eq(businessSubscriptions.planId, subscriptionPlans.id),
          )
          .where(eq(businessSubscriptions.isActive, true))
          .orderBy(asc(businessSubscriptions.createdAt)),
        this.db
          .select({
            businessId: billingProfiles.businessId,
            balance: billingProfiles.balance,
            aiAddon: billingProfiles.aiAddon,
          })
          .from(billingProfiles),
        this.db
          .select({businessId: branches.businessId, c: count()})
          .from(branches)
          .where(eq(branches.isActive, true))
          .groupBy(branches.businessId),
        this.db
          .select({
            businessId: subscriptionDiscounts.businessId,
            ...DISCOUNT_TERM_COLUMNS,
          })
          .from(subscriptionDiscounts)
          .where(eq(subscriptionDiscounts.isActive, true))
          .orderBy(asc(subscriptionDiscounts.createdAt)),
        this.db
          .select({businessId: paymentRequests.businessId})
          .from(paymentRequests)
          .where(eq(paymentRequests.status, 'pending')),
      ]);

    const pendingIds = [
      ...new Set(
        subs.map((s) => s.pendingPlanId).filter((id): id is string => !!id),
      ),
    ];
    const pendingPlans = pendingIds.length
      ? await this.db
          .select({
            id: subscriptionPlans.id,
            price: subscriptionPlans.price,
            tier: subscriptionPlans.tier,
          })
          .from(subscriptionPlans)
          .where(inArray(subscriptionPlans.id, pendingIds))
      : [];
    const pendingPlan = new Map(pendingPlans.map((p) => [p.id, p]));
    const balance = new Map(
      profiles.map((p) => [p.businessId, Number(p.balance)]),
    );
    const wantsAiAddon = new Set(
      profiles.filter((p) => p.aiAddon).map((p) => p.businessId),
    );
    const branchCount = new Map(
      branchCounts.map((b) => [b.businessId, Number(b.c)]),
    );
    const discountsBy = new Map<string, DiscountTerm[]>();
    for (const d of discounts) {
      const list = discountsBy.get(d.businessId) ?? [];
      list.push(d);
      discountsBy.set(d.businessId, list);
    }
    const hasPending = new Set(pending.map((p) => p.businessId));

    // Ordered oldest first, so the latest active row wins (as everywhere else).
    const out = new Map<string, PlatformBillingSummary>();
    for (const s of subs) {
      const bal = balance.get(s.businessId) ?? 0;
      // The renewal charges the scheduled plan when there is one.
      const next = (s.pendingPlanId
        ? pendingPlan.get(s.pendingPlanId)
        : undefined) ?? {price: s.planPrice, tier: s.planTier};
      const total = monthlyFor(
        {
          discounts: discountsBy.get(s.businessId) ?? [],
          aiAddonWanted: wantsAiAddon.has(s.businessId),
          now,
        },
        next,
        (branchCount.get(s.businessId) ?? 1) - 1,
      ).total;
      out.set(s.businessId, {
        stage:
          s.endDate == null
            ? 'open_ended'
            : computeBillingStage({
                endDate: s.endDate,
                balance: bal,
                amountNeeded: total,
                now,
              }),
        amountDue: s.endDate == null ? 0 : Math.max(0, total - bal),
        isTrial: s.isTrial,
        paymentPending: hasPending.has(s.businessId),
      });
    }
    // Shops without any active subscription still report a pending request.
    for (const id of hasPending) {
      if (!out.has(id)) {
        out.set(id, {
          stage: 'none',
          amountDue: 0,
          isTrial: false,
          paymentPending: true,
        });
      }
    }
    return out;
  }

  // ─── Crons' queries ───────────────────────────────────────────────────────

  /**
   * Shops a renewal might succeed for right now: an active dated subscription
   * past its end_date, an active business, and money (or a discount that may
   * make the month free). Everything is re-checked inside tryRenew.
   */
  async renewalCandidates(now: Date = new Date()): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({businessId: businessSubscriptions.businessId})
      .from(businessSubscriptions)
      .innerJoin(
        businesses,
        eq(businesses.id, businessSubscriptions.businessId),
      )
      .leftJoin(
        billingProfiles,
        eq(billingProfiles.businessId, businessSubscriptions.businessId),
      )
      .where(
        and(
          eq(businessSubscriptions.isActive, true),
          eq(businesses.isActive, true),
          sql`${businessSubscriptions.endDate} IS NOT NULL`,
          sql`${businessSubscriptions.endDate} <= ${now.toISOString()}::timestamptz`,
          sql`(coalesce(${billingProfiles.balance}, 0) > 0 OR EXISTS (
                SELECT 1 FROM ${subscriptionDiscounts}
                 WHERE ${subscriptionDiscounts.businessId} = ${businessSubscriptions.businessId}
                   AND ${subscriptionDiscounts.isActive}))`,
        ),
      );
    return rows.map((r) => r.businessId);
  }

  /** Active dated subscriptions of active shops ending before `horizon` (or already ended). */
  async noticeCandidates(horizon: Date): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({businessId: businessSubscriptions.businessId})
      .from(businessSubscriptions)
      .innerJoin(
        businesses,
        eq(businesses.id, businessSubscriptions.businessId),
      )
      .where(
        and(
          eq(businessSubscriptions.isActive, true),
          eq(businesses.isActive, true),
          sql`${businessSubscriptions.endDate} IS NOT NULL`,
          sql`${businessSubscriptions.endDate} <= ${horizon.toISOString()}::timestamptz`,
        ),
      );
    return rows.map((r) => r.businessId);
  }

  /** What the daily notice run needs about one shop. */
  async noticeState(businessId: string) {
    const core = await this.statusCore(businessId, new Date());
    const sub = core.q.sub;
    return {
      stage: core.stage,
      endDate: core.endDate,
      daysLeft: core.daysLeft,
      isTrial: sub?.isTrial ?? false,
      planName: sub?.plan.name ?? null,
      amountDue: core.q.amountDue,
    };
  }
}

/** Postgres unique-violation SQLSTATE (23505), wrapped or not. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as {code?: string; cause?: {code?: string}} | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

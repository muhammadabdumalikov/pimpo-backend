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
  billingNotices,
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
import {BranchScopeService} from '../permission/branch-scope.service';
import {SubscriptionService} from '../subscription/subscription.service';
import {TelegramNotifyService} from '../telegram/telegram-notify.service';
import type {TelegramUrlButton} from '../telegram/telegram-sender.service';
import {generateId} from '../utils/uuid';
import {isBusinessType} from '../common/business-type';
import type {BillingInfo} from '../subscription/subscription.service';
import {
  asBillingCycle,
  cycleTotal,
  periodAmount,
  type BillingCycle,
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
  settleAiUsage,
  type BillingTransactionMeta,
  type BillingTransactionType,
  type Tx,
} from './billing-ledger';
import {renewalMonthlyTotal, renewalReserve} from './ai-usage';
import {
  BRANCH_FREE_DAYS,
  BRANCH_FREE_MS,
  branchBillingState,
  fitRenewal,
  isBranchClosed,
  type BranchBillingState,
} from './branch-billing';
import {
  NOTICE_KIND,
  billingNoticeButton,
  billingNoticeText,
  billingRenewedText,
  paymentRequestedText,
  reminderVerdict,
  tashkentDate,
  type BillingNoticeKind,
  type ReminderVerdict,
} from './billing-text';
import type {PaymentRequestFilter} from './dto/billing.dto';

const DAY_MS = 86_400_000;
// A rejection stays on the shop's screen this long (§6.1 lastRejected).
const REJECTION_VISIBLE_MS = 7 * DAY_MS;
const REQUISITES_KEY = 'payment_requisites';
// Where a billing push/inbox tap lands.
const SUBSCRIPTION_URL = '/subscription-management';

// billing_notices.kind of a payment reminder sent by hand from the platform
// console; the daily run's kinds are BillingNoticeKind.
const MANUAL_NOTICE = 'manual';
const REMINDER_COOLDOWN_MINUTES = 10;

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
  /** Extra stores in warning or closed, as far as this account sees (FILIAL-OBUNA.md Q6). */
  stores: StoreAlert[];
  pay: null | {
    amountDue: number;
    /** What the next renewal charges (a year when `cycle` is 'year'). */
    monthlyTotal: number;
    /** The cycle `monthlyTotal` and `amountDue` are for (OBUNA-TOLOV.md §9). */
    cycle: BillingCycle;
    /** One month — the least a renewal takes when a year is not covered. */
    minimumTotal: number;
    balance: number;
    lastRejected: LastRejected | null;
  };
}

export interface PaymentInfo {
  amountDue: number;
  /** What the next renewal charges (a year when `cycle` is 'year'). */
  monthlyTotal: number;
  cycle: BillingCycle;
  /** One month — the least a renewal takes when a year is not covered. */
  minimumTotal: number;
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
  /**
   * What renewing on the target plan would charge from today's balance, the
   * way tryRenew decides it: a wanted year when the balance covers it, else a
   * month (OBUNA-TOLOV.md §9). The expired path's dialog names this period.
   */
  renewal: {cycle: BillingCycle; amount: number; yearAmount: number};
}

/**
 * The renewal tryRenew would make: the wanted year when the balance covers
 * it, otherwise a month (OBUNA-TOLOV.md §9). `yearAmount` is the year's price
 * either way, so the dialog can say what a year would need.
 */
export function renewalQuote(
  monthlyTotal: number,
  wanted: BillingCycle,
  balance: number,
): PlanChangePreview['renewal'] {
  const yearAmount = cycleTotal(monthlyTotal, 'year');
  const cycle: BillingCycle =
    wanted === 'year' && balance >= yearAmount ? 'year' : 'month';
  return {cycle, amount: cycle === 'year' ? yearAmount : monthlyTotal, yearAmount};
}

export interface BranchBillingPreview {
  /** Always false: opening a store never charges (FILIAL-OBUNA.md). */
  chargeable: boolean;
  charge: number;
  monthlyPrice: number;
  /** Days of the running period left when the free days end. */
  daysRemaining: number;
  balance: number;
  shortfall: number;
  freeDays: number;
  /** The plan pays for every store (trial, admin open-ended): nothing is taken. */
  covered: boolean;
  /** What the end of the free days takes from the balance (0 when covered). */
  afterFree: number;
}

/** One store on the subscription page (GET /subscriptions/stores). */
export interface StoreBillingView {
  id: string;
  name: string;
  isMain: boolean;
  state: BranchBillingState;
  /** Free or paid up to here. */
  until: string | null;
  /** When a store in warning closes. */
  closesAt: string | null;
  /** Tashkent days to `closesAt` (warning) or to the end of the free days. */
  daysLeft: number | null;
  renew: boolean;
  /** The plan for the main store, one store's share for the others. */
  monthlyPrice: number;
  openedAt: string;
}

/** A store the banner tells about (BillingStatus.stores). */
export interface StoreAlert {
  id: string;
  name: string;
  state: 'warning' | 'closed';
  closesAt: string | null;
  daysLeft: number | null;
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
  /** Extra stores the owner keeps renewing. */
  extraBranches: number;
  /**
   * The shop's active discount rows. Which of them hold depends on the plan
   * being priced (a special price is tied to one plan), so they are resolved
   * per plan in monthlyFor(), not once here.
   */
  discounts: DiscountTerm[];
  /** The cycle the next renewal is for, as the owner set it (OBUNA-TOLOV.md §9). */
  cycleWanted: BillingCycle;
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
  ctx: Pick<BillingContext, 'discounts' | 'now'>,
  plan: {tier: string; price: string | number} | null,
  extraBranches: number,
): MonthlyTotal {
  return computeMonthlyTotal({
    planPrice: plan ? Number(plan.price) : 0,
    planTier: plan?.tier ?? null,
    extraBranches,
    discounts: ctx.discounts,
    now: ctx.now,
  });
}

/** What the next renewal will charge and what the shop is short of it. */
interface Quote {
  sub: ActiveSubscription | null;
  balance: number;
  /** The cycle the next renewal is for, as the owner set it. */
  cycle: BillingCycle;
  /** What the next renewal charges: a year when the owner chose yearly. */
  renewalTotal: number;
  /**
   * The least that keeps the shop running: one month. A renewal short of a
   * wanted year still takes a month (OBUNA-TOLOV.md §9), so the warnings measure this.
   */
  minimumTotal: number;
  /**
   * A month of the plan alone (FILIAL-OBUNA.md Q2): what keeps KPOS open. The
   * shop-level warnings ("KPOS yopiladi") measure this; a balance that covers
   * it but not every store only closes the stores it leaves out.
   */
  keepOpenTotal: number;
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
    private readonly scopes: BranchScopeService,
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
    const branchRows = await tx
      .select({isDefault: branches.isDefault, renew: branches.renew})
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
      .select({billingCycle: billingProfiles.billingCycle})
      .from(billingProfiles)
      .where(eq(billingProfiles.businessId, businessId));

    return {
      balance,
      cycleWanted: asBillingCycle(profile?.billingCycle),
      sub: subRow ? {...subRow.sub, plan: subRow.plan} : null,
      activeBranches: branchRows.length,
      // The extra stores the next renewal bills: a store the owner stopped
      // renewing is not one of them (FILIAL-OBUNA.md).
      extraBranches: branchRows.filter((b) => !b.isDefault && b.renew).length,
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
    let monthlyTotal = billing.monthly.total;
    // The plan the renewal charges: the scheduled one when there is one.
    let renewPlan: {price: string | number; tier: string} | null =
      sub?.plan ?? null;
    if (sub?.pendingPlanId) {
      const pending = await this.subscriptions.getPlanById(sub.pendingPlanId);
      if (pending) {
        renewPlan = pending;
        // Re-priced from the rows, not from the current plan's percent: a
        // discount tied to the current plan does not follow the shop down.
        monthlyTotal = computeMonthlyTotal({
          planPrice: Number(pending.price),
          planTier: pending.tier,
          extraBranches: billing.monthly.extraBranches,
          discounts: billing.discounts,
        }).total;
      }
    }
    const keepOpenTotal = renewPlan
      ? computeMonthlyTotal({
          planPrice: Number(renewPlan.price),
          planTier: renewPlan.tier,
          extraBranches: 0,
          discounts: billing.discounts,
        }).total
      : 0;
    // Older cached views (before OBUNA-TOLOV.md §9) carry no cycle block.
    const wanted = asBillingCycle(billing.cycle?.wanted);
    const renewalTotal = cycleTotal(monthlyTotal, wanted);
    return {
      sub,
      balance: billing.balance,
      cycle: wanted,
      renewalTotal,
      minimumTotal: monthlyTotal,
      keepOpenTotal,
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
          amountNeeded: q.keepOpenTotal,
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
    const stores = await this.storeAlerts(businessId, account, sub, now);
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
      stores,
      pay: canPay
        ? {
            amountDue: core.q.amountDue,
            monthlyTotal: core.q.renewalTotal,
            cycle: core.q.cycle,
            minimumTotal: core.q.minimumTotal,
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
      cycle: q.cycle,
      minimumTotal: q.minimumTotal,
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

      // The stores this renewal may take, oldest first (FILIAL-OBUNA.md Q9):
      // every extra store the owner keeps renewing, except one still in its
      // free days — that one pays its share when they end.
      const stores = await this.extraStores(tx, businessId);
      const candidates = stores.filter(
        (b) => b.renew && !(b.freeUntil && asDate(b.freeUntil) > now),
      );
      // Short of the plan alone, nothing changes and the whole shop goes into
      // its grace (Q2). A wanted year the balance cannot cover falls back to a
      // month (OBUNA-TOLOV.md §9); a month takes as many stores as it covers.
      const fit = fitRenewal({
        balance: ctx.balance,
        candidates: candidates.length,
        totalFor: (k) => monthlyFor(ctx, plan, k).total,
        cycleWanted: ctx.cycleWanted,
        yearTotal: (m) => cycleTotal(m, 'year'),
      });
      if (!fit.renews) return null;
      const monthly = monthlyFor(ctx, plan, fit.stores);
      const cycle: BillingCycle = fit.cycle;
      const yearly = cycleTotal(monthly.total, 'year');
      const charged = cycle === 'year' ? yearly : monthly.total;
      const renewedStores = candidates.slice(0, fit.stores);
      const leftOut = candidates.slice(fit.stores);
      const oldEnd = asDate(sub.endDate);

      const period = nextPeriod(sub.endDate, now, cycle);
      const posted = await postBillingTransaction(tx, businessId, {
        type: 'renewal',
        amount: -charged,
        meta: {
          planTier: plan.tier,
          planName: plan.name,
          ...(cycle === 'year' && {
            cycle,
            yearlyDiscount: monthly.total * 12 - yearly,
          }),
          ...(plan.id !== sub.plan.id && {fromPlanName: sub.plan.name}),
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          extraBranches: monthly.extraBranches,
          discountPercent: monthly.discountPercent,
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
        billingCycle: cycle,
      });
      if (renewedStores.length) {
        await tx
          .update(branches)
          .set({paidUntil: period.end, updatedAt: now})
          .where(inArray(branches.id, renewedStores.map((b) => b.id)));
      }
      // A store settled through the old period that the balance did not
      // cover starts its warning days now, not back at the old end.
      const startWarning = leftOut.filter(
        (b) => sub.isTrial || (b.paidUntil && asDate(b.paidUntil) >= oldEnd),
      );
      if (startWarning.length) {
        await tx
          .update(branches)
          .set({paidUntil: now, updatedAt: now})
          .where(inArray(branches.id, startWarning.map((b) => b.id)));
      }
      // The bot's answers come out after the renewal, not before: the coming
      // month has first call on the balance (ai-usage.ts renewalReserve), so
      // the bot can never be what leaves it short. What the rest does not
      // cover stays owed and keeps the bot off until a top-up. No reserve
      // here — the next end is a whole period away.
      const settled = await settleAiUsage(tx, businessId);
      return {
        plan,
        monthly,
        charged,
        cycle,
        yearlyFellBack: ctx.cycleWanted === 'year' && cycle === 'month',
        period,
        balanceAfter: settled?.balanceAfter ?? posted.balanceAfter,
        storesLeftOut: leftOut.map((b) => b.name),
      };
    });

    if (!result) {
      // Not due for renewal (or short of the plan): a store whose free days
      // ended, or one waiting for money, may still be settled from the balance.
      await this.settleBranches(businessId, now);
      return {renewed: false};
    }
    await this.invalidate(businessId);
    await this.reconcileBranchClosures(businessId, now);

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
        charged: result.charged,
        balanceAfter: result.balanceAfter,
        nextShortfall,
        yearly: result.cycle === 'year',
        yearlyFellBack: result.yearlyFellBack,
        storesLeftOut: result.storesLeftOut,
      }),
      {
        kind: 'renewed',
        planName: result.plan.name,
        periodEnd: tashkentDate(result.period.end),
        charged: result.charged,
        // OBUNA-TOLOV.md §9: the inbox text says "1 yil" / "bir oyga" from these.
        yearly: result.cycle === 'year',
        yearlyFellBack: result.yearlyFellBack,
        balance: result.balanceAfter,
        shortfall: nextShortfall,
        ...(result.storesLeftOut.length && {
          storesLeftOut: result.storesLeftOut,
        }),
      },
    );
    this.logger.log(
      `Renewed ${businessId}: ${result.plan.tier} until ${result.period.end.toISOString()} (−${result.charged})`,
    );
    return {renewed: true};
  }

  /** Fire-and-forget billing notice: Telegram + inbox/push, no toggles. */
  sendBilling(
    businessId: string,
    message: string,
    data: Record<string, unknown>,
    buttons?: TelegramUrlButton[][],
  ): void {
    void this.telegram
      .dispatchBilling(
        businessId,
        message,
        {event: 'billing', data: {...data, url: SUBSCRIPTION_URL}},
        buttons,
      )
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
    // On a yearly period the difference is charged at the yearly price.
    const charge =
      kind === 'upgrade'
        ? prorate({
            monthlyAmount: periodAmount(
              targetMonthly.total - currentMonthly.total,
              asBillingCycle(sub?.billingCycle),
            ),
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
      renewal: renewalQuote(targetMonthly.total, ctx.cycleWanted, ctx.balance),
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
      renewal: q.renewal,
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

  // ─── Stores (FILIAL-OBUNA.md) ─────────────────────────────────────────────

  /** The shop's extra stores, oldest first — the order money reaches them (Q9). */
  private extraStores(tx: Tx, businessId: string) {
    return tx
      .select({
        id: branches.id,
        name: branches.name,
        createdAt: branches.createdAt,
        freeUntil: branches.freeUntil,
        paidUntil: branches.paidUntil,
        renew: branches.renew,
      })
      .from(branches)
      .where(
        and(
          eq(branches.businessId, businessId),
          eq(branches.isActive, true),
          eq(branches.isDefault, false),
        ),
      )
      .orderBy(asc(branches.createdAt), asc(branches.id));
  }

  /**
   * Pay the share of the running period for every extra store that is due —
   * its free days are over, or it waits in its warning days, or it is closed —
   * oldest first while the balance covers it (Q9). The share is the rest of
   * the period at the period's cycle price, net of any discount on stores.
   * Nothing to do on a trial, an open-ended plan or past the shop's end (the
   * renewal takes the stores then). Idempotent, under the billing lock.
   */
  async settleBranches(businessId: string, now: Date = new Date()): Promise<string[]> {
    const settled = await this.db.transaction(async (tx) => {
      const ctx = await this.loadContext(tx, businessId, now, true);
      const sub = ctx.sub;
      if (
        !sub ||
        sub.endDate == null ||
        sub.isTrial ||
        isPastEnd(sub.endDate, now)
      ) {
        return [];
      }
      const end = asDate(sub.endDate);
      const stores = await this.extraStores(tx, businessId);
      const paidThrough = (b: (typeof stores)[number]) =>
        !!b.paidUntil && asDate(b.paidUntil) >= end;
      let paid = stores.filter(paidThrough).length;
      const due = stores.filter(
        (b) =>
          b.renew &&
          !(b.freeUntil && asDate(b.freeUntil) > now) &&
          !paidThrough(b),
      );
      if (!due.length) return [];

      const days = periodDays(sub.startDate, sub.endDate, now);
      const cycle = asBillingCycle(sub.billingCycle);
      let balance = ctx.balance;
      const out: string[] = [];
      for (const store of due) {
        const charge = prorate({
          monthlyAmount: periodAmount(
            monthlyFor(ctx, sub.plan, paid + 1).total -
              monthlyFor(ctx, sub.plan, paid).total,
            cycle,
          ),
          ...days,
        });
        if (charge > balance) break;
        if (charge > 0) {
          const posted = await postBillingTransaction(tx, businessId, {
            type: 'branch',
            amount: -charge,
            meta: {
              branchName: store.name,
              days: days.daysRemaining,
              extraBranches: paid + 1,
              periodEnd: end.toISOString(),
            },
            createdBy: 'system',
          });
          balance = posted.balanceAfter;
        }
        await tx
          .update(branches)
          .set({paidUntil: end, updatedAt: now})
          .where(eq(branches.id, store.id));
        paid++;
        out.push(store.name);
      }
      if (out.length) {
        await tx
          .update(businessSubscriptions)
          .set({
            paidExtraBranches: Math.max(sub.paidExtraBranches, paid),
            updatedAt: now,
          })
          .where(eq(businessSubscriptions.id, sub.id));
      }
      return out;
    });
    if (settled.length) {
      await this.invalidate(businessId);
      this.logger.log(`Settled stores of ${businessId}: ${settled.join(', ')}`);
    }
    await this.reconcileBranchClosures(businessId, now);
    return settled;
  }

  /**
   * Bring every store's closed flag in step with its state: set it when the
   * store closes, clear it when it is paid (or covered) again. The branch_stock
   * trigger and the staff lock read the flag, so this runs after every change
   * that can move a store, and on the sweep for the ones time moves.
   */
  async reconcileBranchClosures(
    businessId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const [subRow] = await this.db
      .select({
        endDate: businessSubscriptions.endDate,
        isTrial: businessSubscriptions.isTrial,
      })
      .from(businessSubscriptions)
      .where(
        and(
          eq(businessSubscriptions.businessId, businessId),
          eq(businessSubscriptions.isActive, true),
        ),
      )
      .orderBy(desc(businessSubscriptions.createdAt))
      .limit(1);
    const rows = await this.db
      .select({
        id: branches.id,
        isDefault: branches.isDefault,
        createdAt: branches.createdAt,
        freeUntil: branches.freeUntil,
        paidUntil: branches.paidUntil,
        renew: branches.renew,
        billingClosedAt: branches.billingClosedAt,
      })
      .from(branches)
      .where(
        and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
      );
    const close: string[] = [];
    const open: string[] = [];
    for (const r of rows) {
      const closed = isBranchClosed(r, subRow ?? null, now);
      if (closed && !r.billingClosedAt) close.push(r.id);
      else if (!closed && r.billingClosedAt) open.push(r.id);
    }
    if (close.length) {
      await this.db
        .update(branches)
        .set({billingClosedAt: now, updatedAt: now})
        .where(inArray(branches.id, close));
    }
    if (open.length) {
      await this.db
        .update(branches)
        .set({billingClosedAt: null, updatedAt: now})
        .where(inArray(branches.id, open));
    }
    if (close.length || open.length) await this.invalidate(businessId);
    return close.length + open.length;
  }

  /** What one extra store and the plan (the main store) cost a month now. */
  private storePrices(ctx: BillingContext) {
    const plan = ctx.sub?.plan ?? null;
    const k = Math.max(1, ctx.extraBranches);
    return {
      main: monthlyFor(ctx, plan, 0).total,
      store: monthlyFor(ctx, plan, k).total - monthlyFor(ctx, plan, k - 1).total,
    };
  }

  /**
   * GET /subscriptions/stores — every store with its billing state, for the
   * subscription page. A staff account pinned to one store sees that one only
   * (Q6).
   */
  async listStores(
    businessId: string,
    account: IAccount,
  ): Promise<StoreBillingView[]> {
    return this.storesView(businessId, await this.scopes.scopeFor(account));
  }

  /** The platform console's store list: every store. */
  storesForPlatform(businessId: string): Promise<StoreBillingView[]> {
    return this.storesView(businessId, null);
  }

  private async storesView(
    businessId: string,
    pinned: string | null,
  ): Promise<StoreBillingView[]> {
    const now = new Date();
    const [ctx, rows] = await Promise.all([
      this.readContext(businessId, now),
      this.db
        .select({
          id: branches.id,
          name: branches.name,
          isDefault: branches.isDefault,
          createdAt: branches.createdAt,
          freeUntil: branches.freeUntil,
          paidUntil: branches.paidUntil,
          renew: branches.renew,
        })
        .from(branches)
        .where(
          and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
        )
        .orderBy(desc(branches.isDefault), asc(branches.createdAt)),
    ]);
    const prices = this.storePrices(ctx);
    return rows
      .filter((r) => !pinned || r.id === pinned)
      .map((r) => {
        const v = branchBillingState(r, ctx.sub, now);
        const daysTo = (d: Date | null) =>
          d ? Math.max(0, tashkentDaysBetween(now, d)) : null;
        return {
          id: r.id,
          name: r.name,
          isMain: r.isDefault,
          state: v.state,
          until: v.until?.toISOString() ?? null,
          closesAt: v.closesAt?.toISOString() ?? null,
          daysLeft: daysTo(v.closesAt ?? (v.state === 'free' ? v.until : null)),
          renew: r.isDefault ? true : r.renew,
          monthlyPrice: r.isDefault ? prices.main : prices.store,
          openedAt: asDate(r.createdAt).toISOString(),
        };
      });
  }

  /**
   * The stores in warning or closed that this account should be told about:
   * all of them for the owner and staff who see every store, the own store
   * for a pinned one (Q6). For the banner on every page.
   */
  private async storeAlerts(
    businessId: string,
    account: IAccount,
    sub: {endDate: Date | string | null; isTrial: boolean} | null,
    now: Date,
  ): Promise<StoreAlert[]> {
    if (!sub || sub.endDate == null || sub.isTrial) return [];
    const [rows, pinned] = await Promise.all([
      this.db
        .select({
          id: branches.id,
          name: branches.name,
          isDefault: branches.isDefault,
          createdAt: branches.createdAt,
          freeUntil: branches.freeUntil,
          paidUntil: branches.paidUntil,
          renew: branches.renew,
        })
        .from(branches)
        .where(
          and(
            eq(branches.businessId, businessId),
            eq(branches.isActive, true),
            eq(branches.isDefault, false),
          ),
        )
        .orderBy(asc(branches.createdAt)),
      this.scopes.scopeFor(account),
    ]);
    const out: StoreAlert[] = [];
    for (const r of rows) {
      if (pinned && r.id !== pinned) continue;
      const v = branchBillingState(r, sub, now);
      if (v.state !== 'warning' && v.state !== 'closed') continue;
      // A store the owner stopped renewing closing is no news to the owner.
      if (v.state === 'closed' && !r.renew) continue;
      out.push({
        id: r.id,
        name: r.name,
        state: v.state,
        closesAt: v.closesAt?.toISOString() ?? null,
        daysLeft: v.closesAt
          ? Math.max(0, tashkentDaysBetween(now, v.closesAt))
          : null,
      });
    }
    return out;
  }

  /**
   * PUT /subscriptions/stores/:id/renew — keep renewing an extra store, or
   * stop: it then closes when its paid time runs out, without being deleted.
   * Switched back on, a due store is settled from the balance at once.
   */
  async setStoreRenew(
    businessId: string,
    account: IAccount,
    branchId: string,
    renew: boolean,
  ): Promise<StoreBillingView[]> {
    const [row] = await this.db
      .select({id: branches.id, isDefault: branches.isDefault})
      .from(branches)
      .where(
        and(
          eq(branches.id, branchId),
          eq(branches.businessId, businessId),
          eq(branches.isActive, true),
        ),
      )
      .limit(1);
    const pinned = await this.scopes.scopeFor(account);
    if (!row || (pinned && pinned !== branchId)) {
      throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
    }
    if (row.isDefault) {
      throw new AppException(ErrorCode.BRANCH_MAIN_RENEW_FORBIDDEN);
    }
    await this.db
      .update(branches)
      .set({renew, updatedAt: new Date()})
      .where(eq(branches.id, branchId));
    await this.invalidate(businessId);
    if (renew) await this.settleBranches(businessId);
    else await this.reconcileBranchClosures(businessId);
    return this.listStores(businessId, account);
  }

  /** GET /branches/billing-preview — what opening one more store means now. */
  async previewBranchCharge(businessId: string): Promise<BranchBillingPreview> {
    const now = new Date();
    const ctx = await this.readContext(businessId, now);
    const sub = ctx.sub;
    const covered = !sub || sub.endDate == null || sub.isTrial;
    const freeEnd = new Date(now.getTime() + BRANCH_FREE_MS);
    // Free days that end inside the running period are followed by its rest;
    // ending past it, the store is taken by the renewal instead.
    const days =
      !covered && sub?.endDate && freeEnd < asDate(sub.endDate)
        ? periodDays(sub.startDate, sub.endDate, freeEnd)
        : {daysRemaining: 0, periodDays: 1};
    const plan = sub?.plan ?? null;
    const k = ctx.extraBranches + 1;
    const monthlyPrice =
      monthlyFor(ctx, plan, k).total - monthlyFor(ctx, plan, k - 1).total;
    const afterFree = covered
      ? 0
      : prorate({
          monthlyAmount: periodAmount(
            monthlyPrice,
            asBillingCycle(sub?.billingCycle),
          ),
          ...days,
        });
    return {
      // Opening never charges now (FILIAL-OBUNA.md); kept for older clients.
      chargeable: false,
      charge: 0,
      shortfall: 0,
      monthlyPrice,
      daysRemaining: days.daysRemaining,
      balance: ctx.balance,
      freeDays: BRANCH_FREE_DAYS,
      covered,
      afterFree,
    };
  }

  /** Free days for a store opened now. */
  branchFreeUntil(now: Date = new Date()): Date {
    return new Date(now.getTime() + BRANCH_FREE_MS);
  }

  /**
   * The shops the store sweep looks at: an extra store that is due (free days
   * over, not paid through the period) or carries the closed flag.
   */
  async storeSweepCandidates(now: Date = new Date()): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({businessId: branches.businessId})
      .from(branches)
      .leftJoin(
        businessSubscriptions,
        and(
          eq(businessSubscriptions.businessId, branches.businessId),
          eq(businessSubscriptions.isActive, true),
        ),
      )
      .where(
        and(
          eq(branches.isActive, true),
          eq(branches.isDefault, false),
          sql`(${branches.billingClosedAt} IS NOT NULL OR (
                ${businessSubscriptions.endDate} IS NOT NULL
                AND NOT ${businessSubscriptions.isTrial}
                AND (${branches.freeUntil} IS NULL OR ${branches.freeUntil} <= ${now.toISOString()}::timestamptz)
                AND (${branches.paidUntil} IS NULL OR ${branches.paidUntil} < ${businessSubscriptions.endDate})))`,
        ),
      );
    return rows.map((r) => r.businessId);
  }

  /**
   * The stores the daily note names (§3): those in warning, and those closed
   * within the last two days — older closures are no news. Stores the owner
   * stopped renewing are left out.
   */
  async storeNoticeState(
    businessId: string,
    now: Date = new Date(),
  ): Promise<{name: string; state: 'warning' | 'closed'; daysLeft: number}[]> {
    const [subRow] = await this.db
      .select({
        endDate: businessSubscriptions.endDate,
        isTrial: businessSubscriptions.isTrial,
      })
      .from(businessSubscriptions)
      .where(
        and(
          eq(businessSubscriptions.businessId, businessId),
          eq(businessSubscriptions.isActive, true),
        ),
      )
      .orderBy(desc(businessSubscriptions.createdAt))
      .limit(1);
    if (!subRow || subRow.endDate == null || subRow.isTrial) return [];
    const rows = await this.db
      .select({
        name: branches.name,
        isDefault: branches.isDefault,
        createdAt: branches.createdAt,
        freeUntil: branches.freeUntil,
        paidUntil: branches.paidUntil,
        renew: branches.renew,
        billingClosedAt: branches.billingClosedAt,
      })
      .from(branches)
      .where(
        and(
          eq(branches.businessId, businessId),
          eq(branches.isActive, true),
          eq(branches.isDefault, false),
          eq(branches.renew, true),
        ),
      )
      .orderBy(asc(branches.createdAt));
    const recent = now.getTime() - 2 * DAY_MS;
    const out: {name: string; state: 'warning' | 'closed'; daysLeft: number}[] = [];
    for (const r of rows) {
      const v = branchBillingState(r, subRow, now);
      if (v.state === 'warning' && v.closesAt) {
        out.push({
          name: r.name,
          state: 'warning',
          daysLeft: Math.max(0, tashkentDaysBetween(now, v.closesAt)),
        });
      } else if (
        v.state === 'closed' &&
        r.billingClosedAt &&
        asDate(r.billingClosedAt).getTime() >= recent
      ) {
        out.push({name: r.name, state: 'closed', daysLeft: 0});
      }
    }
    return out;
  }

  // ─── AI bot answers (ONLAYN-SOTUVCHI.md §11, ai-usage.ts) ─────────────────

  /** Shops with bot answers waiting to be taken from the balance. */
  async aiUsageCandidates(): Promise<string[]> {
    const rows = await this.db
      .select({businessId: billingProfiles.businessId})
      .from(billingProfiles)
      .where(sql`${billingProfiles.aiUnbilled} >= 1`);
    return rows.map((r) => r.businessId);
  }

  /**
   * Take a shop's accrued bot answers from its balance as one ledger line,
   * leaving the coming renewal's money alone (the same reserve the bot's
   * spending is held to). Safe to call at any time and from two instances at
   * once: it runs under the profile lock and takes only what is still owed.
   */
  async settleAiUsage(
    businessId: string,
    now: Date = new Date(),
  ): Promise<{settled: boolean}> {
    const taken = await this.db.transaction(async (tx) => {
      const ctx = await this.loadContext(tx, businessId, now, true);
      const sub = ctx.sub;
      if (!sub) return settleAiUsage(tx, businessId);
      // The plan the renewal will charge: a scheduled downgrade's, like tryRenew.
      const [pendingPlan] = sub.pendingPlanId
        ? await tx
            .select()
            .from(subscriptionPlans)
            .where(eq(subscriptionPlans.id, sub.pendingPlanId))
            .limit(1)
        : [];
      const reserve = renewalReserve({
        endDate: sub.endDate,
        monthlyTotal: renewalMonthlyTotal({
          plan: sub.plan,
          pendingPlan,
          extraBranches: ctx.extraBranches,
          discounts: ctx.discounts,
          now,
        }),
        cycleWanted: ctx.cycleWanted,
        balance: ctx.balance,
        now,
      });
      return settleAiUsage(tx, businessId, reserve);
    });
    if (!taken) return {settled: false};
    await this.invalidate(businessId);
    return {settled: true};
  }

  // ─── Billing cycle (OBUNA-TOLOV.md §9) ────────────────────────────────────

  /**
   * POST /subscriptions/billing-cycle — monthly or yearly from the next
   * renewal on. Nothing is charged or refunded now: the current period runs
   * out at the price it was paid for, and a wanted year the balance cannot
   * cover at renewal falls back to a month.
   */
  async setBillingCycle(
    businessId: string,
    cycle: BillingCycle,
  ): Promise<BillingInfo['cycle']> {
    await this.db.transaction(async (tx) => {
      await lockBillingProfile(tx, businessId);
      await tx
        .update(billingProfiles)
        .set({billingCycle: cycle, updatedAt: new Date()})
        .where(eq(billingProfiles.businessId, businessId));
    });
    await this.invalidate(businessId);
    return (await this.subscriptions.getBillingInfo(businessId)).cycle;
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
          })
          .from(billingProfiles),
        // The extra stores the renewal bills (FILIAL-OBUNA.md).
        this.db
          .select({businessId: branches.businessId, c: count()})
          .from(branches)
          .where(
            and(
              eq(branches.isActive, true),
              eq(branches.isDefault, false),
              eq(branches.renew, true),
            ),
          )
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
      const pricing = {
        discounts: discountsBy.get(s.businessId) ?? [],
        now,
      };
      const total = monthlyFor(
        pricing,
        next,
        branchCount.get(s.businessId) ?? 0,
      ).total;
      out.set(s.businessId, {
        stage:
          s.endDate == null
            ? 'open_ended'
            : computeBillingStage({
                endDate: s.endDate,
                balance: bal,
                // What keeps KPOS open: the plan alone (FILIAL-OBUNA.md Q2).
                amountNeeded: monthlyFor(pricing, next, 0).total,
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
  async noticeState(businessId: string): Promise<BillingNoticeState> {
    const core = await this.statusCore(businessId, new Date());
    const sub = core.q.sub;
    return {
      stage: core.stage,
      endDate: core.endDate,
      daysLeft: core.daysLeft,
      isTrial: sub?.isTrial ?? false,
      planName: sub?.plan.name ?? null,
      amountDue: core.q.amountDue,
      graceDaysLeft: core.graceDaysLeft,
    };
  }

  /** The message and inbox data of one notice — the daily run's and a hand-sent one's alike. */
  noticePayload(
    s: BillingNoticeState & {endDate: Date},
    kind: BillingNoticeKind,
  ): {
    text: string;
    data: Record<string, unknown>;
    buttons: TelegramUrlButton[][];
  } {
    return {
      buttons: [[billingNoticeButton({isTrial: s.isTrial})]],
      text: billingNoticeText({
        kind,
        isTrial: s.isTrial,
        daysLeft: s.daysLeft ?? 0,
        endDate: s.endDate,
        amountDue: s.amountDue,
        planName: s.planName,
        graceDaysLeft: s.graceDaysLeft,
      }),
      data: {
        kind,
        isTrial: s.isTrial,
        daysLeft: s.daysLeft,
        amountDue: s.amountDue,
        planName: s.planName,
      },
    };
  }

  // ─── Payment reminder by hand (platform console) ──────────────────────────

  /**
   * Whether the console may send this shop a payment reminder now, and what
   * it would say: the same notice the daily run sends for the shop's stage.
   */
  async paymentReminderState(businessId: string): Promise<PaymentReminderState> {
    const [s, chatIds] = await Promise.all([
      this.noticeState(businessId),
      this.telegram.listActiveChatIds(businessId),
    ]);
    const verdict = reminderVerdict({
      stage: s.stage,
      endDate: s.endDate,
      botReady: this.telegram.canSend(),
      chats: chatIds.length,
    });
    const kind = NOTICE_KIND[s.stage];
    const due = kind != null && s.endDate != null;
    const payload = due
      ? this.noticePayload({...s, endDate: s.endDate as Date}, kind)
      : null;

    // The last notice of the running period, the daily run's or a hand-sent one.
    let last: {kind: string; createdAt: Date} | undefined;
    if (s.endDate) {
      [last] = await this.db
        .select({kind: billingNotices.kind, createdAt: billingNotices.createdAt})
        .from(billingNotices)
        .where(
          and(
            eq(billingNotices.businessId, businessId),
            eq(billingNotices.periodEnd, s.endDate),
          ),
        )
        .orderBy(desc(billingNotices.createdAt))
        .limit(1);
    }

    return {
      verdict,
      chats: chatIds.length,
      text: payload?.text ?? null,
      button: payload?.buttons[0]?.[0] ?? null,
      lastSentAt: last?.createdAt ?? null,
      lastSentBy: last ? (last.kind === MANUAL_NOTICE ? 'manual' : 'auto') : null,
    };
  }

  /**
   * Send the reminder now: Telegram + inbox/push, like the daily notice. One
   * hand-sent reminder per period is kept in billing_notices (kind 'manual');
   * its time is both "last sent" and the guard against a double click.
   */
  async sendPaymentReminder(businessId: string): Promise<PaymentReminderState> {
    const [s, chatIds] = await Promise.all([
      this.noticeState(businessId),
      this.telegram.listActiveChatIds(businessId),
    ]);
    const verdict = reminderVerdict({
      stage: s.stage,
      endDate: s.endDate,
      botReady: this.telegram.canSend(),
      chats: chatIds.length,
    });
    if (verdict === 'not_due') {
      throw new AppException(ErrorCode.BILLING_REMINDER_NOT_DUE);
    }
    if (verdict === 'no_bot') {
      throw new AppException(ErrorCode.TELEGRAM_NOT_CONFIGURED);
    }
    if (verdict === 'no_chats') {
      throw new AppException(ErrorCode.TELEGRAM_NO_TARGETS);
    }
    const endDate = s.endDate as Date;
    const kind = NOTICE_KIND[s.stage] as BillingNoticeKind;

    // Claim before sending, in one statement: two clicks cannot both pass.
    const claimed = (await this.db.execute(sql`
      INSERT INTO billing_notices (business_id, period_end, kind)
      VALUES (${businessId}, ${endDate.toISOString()}::timestamptz, ${MANUAL_NOTICE})
      ON CONFLICT (business_id, period_end, kind) DO UPDATE SET created_at = now()
        WHERE billing_notices.created_at < now() - make_interval(mins => ${REMINDER_COOLDOWN_MINUTES})
      RETURNING kind
    `)) as unknown;
    const rows =
      (claimed as {rows?: unknown[]}).rows ?? (claimed as unknown[]);
    if (!rows?.length) {
      throw new AppException(ErrorCode.BILLING_REMINDER_TOO_SOON);
    }

    const notice = this.noticePayload({...s, endDate}, kind);
    await this.telegram.dispatchBilling(
      businessId,
      notice.text,
      {event: 'billing', data: {...notice.data, url: SUBSCRIPTION_URL}},
      notice.buttons,
    );
    this.logger.log(`Payment reminder (${kind}) sent by hand to ${businessId}`);
    return this.paymentReminderState(businessId);
  }
}

/** What the notices are written from. */
export interface BillingNoticeState {
  stage: BillingStage;
  endDate: Date | null;
  daysLeft: number | null;
  isTrial: boolean;
  planName: string | null;
  amountDue: number;
  /** Days until the sections close; null outside the grace period. */
  graceDaysLeft: number | null;
}

/** The platform console's "send a payment reminder" control. */
export interface PaymentReminderState {
  verdict: ReminderVerdict;
  /** Active Telegram chats linked to the shop. */
  chats: number;
  /** The message that goes out now; null when nothing is due. */
  text: string | null;
  /** The button under it, opening the subscription page; null when nothing is due. */
  button: {text: string; url: string} | null;
  /** The last notice of the running period, automatic or by hand. */
  lastSentAt: Date | null;
  lastSentBy: 'auto' | 'manual' | null;
}

/** Postgres unique-violation SQLSTATE (23505), wrapped or not. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as {code?: string; cause?: {code?: string}} | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

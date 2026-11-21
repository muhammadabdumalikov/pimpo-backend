import {Injectable} from '@nestjs/common';
import {and, eq, gte, isNotNull, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {billingProfiles, customerChatMessages} from '../database/schema';
import {
  AI_PROVIDER_IDS,
  defaultModelFor,
  type AiProviderId,
} from '../ai/providers/llm-provider.interface';
import {
  PLAN_FREE_ANSWERS,
  answerCharge,
  botFunds,
  freeAllowance,
  renewalMonthlyTotal,
  renewalReserve,
  spendable,
  typicalAnswerCharge,
  type BotFunds,
} from '../billing/ai-usage';
import {asBillingCycle, asDate, isPastEnd} from '../billing/billing';
import {SHOP_TIME_ZONE} from '../branch/working-hours';
import {SubscriptionService} from './subscription.service';
import {UsdRateService} from './usd-rate.service';

/** Answers a shop must have paid for before its own average is quoted. */
const OWN_PRICE_MIN_ANSWERS = 20;

/** GET /subscriptions/ai-usage — the bot's answers as the shop sees them. */
export interface AiUsageView {
  /** The plan carries the bot (Business+ or the online seller plan). */
  included: boolean;
  /** Free answers of this plan, and how many are used; null when it has none. */
  free: {kind: 'trial' | 'monthly'; limit: number; used: number} | null;
  /** This calendar month: AI answers given, and so'm they cost the shop. */
  month: {answers: number; charged: number};
  /** About what one answer costs, so'm (the shop's own average once it has one). */
  answerPrice: number;
  balance: number;
  /** Held for the coming renewal (0 until its reminders start). */
  reserve: number;
  /** Answers given but not yet taken from the balance. */
  unsettled: number;
  /** What the bot may still spend: balance − unsettled − reserve. */
  spendable: number;
  /** How the next answer is paid for; 'blocked' = questions go to a person. */
  state: BotFunds;
}

/** The provider and model the customer bot runs on (env, else the default). */
export function assistantModel(): {provider: AiProviderId; model: string} {
  const raw = (
    process.env.AI_ASSISTANT_PROVIDER || 'gemini'
  ).trim() as AiProviderId;
  const provider = AI_PROVIDER_IDS.includes(raw) ? raw : 'gemini';
  return {
    provider,
    model: process.env.AI_ASSISTANT_MODEL?.trim() || defaultModelFor(provider),
  };
}

/**
 * The customer AI bot's pay-as-you-go side (ONLAYN-SOTUVCHI.md §11): whether
 * the next answer is free, paid from the balance or not given at all, what an
 * answer costs, and the running sum the daily settlement takes
 * (billing-ledger.ts settleAiUsage). The rules are in billing/ai-usage.ts.
 */
@Injectable()
export class AiUsageService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptions: SubscriptionService,
    private readonly rates: UsdRateService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** AI answers of the shop since `since` (model runs — what an allowance counts). */
  private async answersSince(businessId: string, since: Date): Promise<number> {
    const [{n}] = await this.db
      .select({n: sql<number>`count(*)::int`})
      .from(customerChatMessages)
      .where(
        and(
          eq(customerChatMessages.businessId, businessId),
          eq(customerChatMessages.role, 'bot'),
          isNotNull(customerChatMessages.model),
          gte(customerChatMessages.createdAt, since),
        ),
      );
    return n;
  }

  /** This calendar month on the shop clock: answers, so'm charged, paid answers. */
  private async month(businessId: string) {
    const [row] = await this.db
      .select({
        answers: sql<number>`count(*)::int`,
        charged: sql<string>`coalesce(sum(${customerChatMessages.costUzs}), 0)`,
        paid: sql<number>`count(*) filter (where ${customerChatMessages.costUzs} > 0)::int`,
      })
      .from(customerChatMessages)
      .where(
        and(
          eq(customerChatMessages.businessId, businessId),
          eq(customerChatMessages.role, 'bot'),
          isNotNull(customerChatMessages.model),
          sql`${customerChatMessages.createdAt} >= date_trunc('month', now() AT TIME ZONE ${SHOP_TIME_ZONE}) AT TIME ZONE ${SHOP_TIME_ZONE}`,
        ),
      );
    return {
      answers: row?.answers ?? 0,
      charged: Number(row?.charged ?? 0),
      paid: row?.paid ?? 0,
    };
  }

  async view(businessId: string): Promise<AiUsageView> {
    const [included, sub, billing, month, rate, [profile]] = await Promise.all([
      this.subscriptions.aiAssistantAllowed(businessId),
      this.subscriptions.getBusinessSubscription(businessId),
      this.subscriptions.getBillingInfo(businessId),
      this.month(businessId),
      this.rates.get(),
      // The balance from this row, not from the cached billing view: a
      // settlement moves both columns at once, and a cached balance from
      // before it against a fresh unsettled sum from after it would show
      // the settled amount as spendable a second time.
      this.db
        .select({
          balance: billingProfiles.balance,
          unbilled: billingProfiles.aiUnbilled,
        })
        .from(billingProfiles)
        .where(eq(billingProfiles.businessId, businessId)),
    ]);

    const allowance = included
      ? freeAllowance({
          planTier: sub?.plan.tier ?? null,
          // The trial's free answers end with the trial, not with its grace
          // days (the plan still holds then, so `included` is still true).
          isTrial: !!sub?.isTrial && !isPastEnd(sub.endDate),
          monthlyLimit:
            Number(process.env.AI_ASSISTANT_MONTHLY_LIMIT) || PLAN_FREE_ANSWERS,
        })
      : null;
    const free = allowance
      ? {
          ...allowance,
          used:
            allowance.kind === 'monthly'
              ? month.answers
              : await this.answersSince(businessId, asDate(sub!.startDate)),
        }
      : null;

    const balance = Number(profile?.balance ?? 0);
    // The plan the renewal will charge: a scheduled downgrade's, like tryRenew.
    const pendingPlan = sub?.pendingPlanId
      ? await this.subscriptions.getPlanById(sub.pendingPlanId)
      : null;
    const reserve = renewalReserve({
      endDate: sub?.endDate ?? null,
      monthlyTotal: renewalMonthlyTotal({
        plan: sub?.plan ?? null,
        pendingPlan,
        extraBranches: billing.monthly.extraBranches,
        discounts: billing.discounts,
      }),
      // Older cached views (before OBUNA-TOLOV.md §9) carry no cycle block.
      cycleWanted: asBillingCycle(billing.cycle?.wanted),
      balance,
    });
    const unsettled = Number(profile?.unbilled ?? 0);
    const funds = {balance, unsettled, reserve};
    const {provider, model} = assistantModel();

    return {
      included,
      free,
      month: {answers: month.answers, charged: month.charged},
      answerPrice: Math.max(
        1,
        Math.round(
          month.paid >= OWN_PRICE_MIN_ANSWERS
            ? month.charged / month.paid
            : typicalAnswerCharge(provider, model, rate),
        ),
      ),
      balance,
      reserve,
      unsettled,
      spendable: spendable(funds),
      state: included ? botFunds({free, ...funds}) : 'blocked',
    };
  }

  /** How the next answer is paid for — asked before every model run. */
  async funds(businessId: string): Promise<BotFunds> {
    return (await this.view(businessId)).state;
  }

  /** What these tokens cost the shop, so'm, at today's rate. */
  async price(answer: {
    model: string;
    tokensIn: number;
    tokensOut: number;
  }): Promise<number> {
    return answerCharge({
      provider: assistantModel().provider,
      model: answer.model,
      tokensIn: answer.tokensIn,
      tokensOut: answer.tokensOut,
      usdRate: await this.rates.get(),
    });
  }

  /** Add a paid answer to what the next settlement takes from the balance. */
  async accrue(businessId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const sum = amount.toFixed(2);
    await this.db
      .insert(billingProfiles)
      .values({businessId, aiUnbilled: sum, aiUnbilledAnswers: 1})
      .onConflictDoUpdate({
        target: billingProfiles.businessId,
        set: {
          aiUnbilled: sql`${billingProfiles.aiUnbilled} + ${sum}::numeric`,
          aiUnbilledAnswers: sql`${billingProfiles.aiUnbilledAnswers} + 1`,
        },
      });
  }
}

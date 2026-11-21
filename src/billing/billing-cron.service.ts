import {Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {DatabaseService} from '../database/database.service';
import {billingNotices} from '../database/schema';
import {BillingService} from './billing.service';
import {
  REMINDER_DAYS,
  graceEndsAt,
  tashkentHour,
} from './billing';
import {
  NOTICE_KIND,
  billingNoticeButton,
  branchNoticeText,
} from './billing-text';
import {businessDay} from '../common/business-time';

const DAY_MS = 86_400_000;

// Renewals run only in the daytime (§4): a renewal sends a message, and the
// grace period makes a few hours' delay harmless.
const RENEW_FROM_HOUR = 8;
const RENEW_UNTIL_HOUR = 22;

// "The day the plan was restricted" — a shop that went restricted long ago
// (before this feature, or a churned one) gets no fresh notice for it.
const RESTRICTED_NOTICE_WINDOW_MS = 2 * DAY_MS;

/**
 * The billing schedules (OBUNA-TOLOV.md §4). `BILLING_CRON=off` disables them
 * all — for a local server pointed at a shared database.
 */
@Injectable()
export class BillingCronService {
  private readonly logger = new Logger(BillingCronService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly billing: BillingService,
  ) {}

  private get enabled(): boolean {
    return process.env.BILLING_CRON !== 'off';
  }

  /** Every 5 minutes, 08:00–22:00 Tashkent: renew whatever came due and can pay. */
  @Cron('*/5 * * * *', {name: 'billing-renewal-sweep'})
  async renewDue(): Promise<void> {
    if (!this.enabled) return;
    const hour = tashkentHour();
    if (hour < RENEW_FROM_HOUR || hour >= RENEW_UNTIL_HOUR) return;
    try {
      const ids = await this.billing.renewalCandidates();
      for (const id of ids) {
        try {
          await this.billing.tryRenew(id);
        } catch (e) {
          this.logger.error(
            `Renewal failed for ${id}: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(`Renewal sweep failed: ${(e as Error).message}`);
    }
  }

  /**
   * Every 5 minutes, day and night: settle the extra stores that came due
   * (free days over, or waiting for money) and close the ones whose warning
   * days ran out (FILIAL-OBUNA.md §3). Silent — the daily note tells.
   */
  @Cron('*/5 * * * *', {name: 'billing-store-sweep'})
  async sweepStores(): Promise<void> {
    if (!this.enabled) return;
    try {
      for (const id of await this.billing.storeSweepCandidates()) {
        try {
          await this.billing.settleBranches(id);
        } catch (e) {
          this.logger.error(
            `Store sweep failed for ${id}: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(`Store sweep failed: ${(e as Error).message}`);
    }
  }

  /**
   * 00:10 Tashkent: the day's bot answers leave each balance as one ledger
   * line (ONLAYN-SOTUVCHI.md §11). A shop short of the sum keeps the rest
   * owed; its bot waits for a top-up (ai-usage.ts botFunds).
   */
  @Cron('10 0 * * *', {name: 'billing-ai-usage', timeZone: 'Asia/Tashkent'})
  async settleAiUsage(): Promise<void> {
    if (!this.enabled) return;
    try {
      for (const id of await this.billing.aiUsageCandidates()) {
        try {
          await this.billing.settleAiUsage(id);
        } catch (e) {
          this.logger.error(
            `AI usage settlement failed for ${id}: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(`AI usage settlement failed: ${(e as Error).message}`);
    }
  }

  /**
   * 09:00 Tashkent: d7 / d3 / expired / restricted, each once per period
   * (billing_notices is the dedupe — two instances can't both claim a row).
   * Ignores the shop's notification toggles and its plan tier (Q8).
   */
  @Cron('0 9 * * *', {name: 'billing-notices', timeZone: 'Asia/Tashkent'})
  async sendNotices(): Promise<void> {
    if (!this.enabled) return;
    const now = new Date();
    try {
      const horizon = new Date(now.getTime() + (REMINDER_DAYS + 1) * DAY_MS);
      for (const id of await this.billing.noticeCandidates(horizon)) {
        try {
          await this.noticeFor(id, now);
        } catch (e) {
          this.logger.error(
            `Billing notice failed for ${id}: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(`Billing notice run failed: ${(e as Error).message}`);
    }
    try {
      for (const id of await this.billing.storeSweepCandidates(now)) {
        try {
          await this.storeNoticeFor(id, now);
        } catch (e) {
          this.logger.error(
            `Store notice failed for ${id}: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(`Store notice run failed: ${(e as Error).message}`);
    }
  }

  /**
   * One note a day per shop naming its stores in warning and those closed in
   * the last two days (FILIAL-OBUNA.md §3); billing_notices keyed by the
   * Tashkent day is the dedupe.
   */
  private async storeNoticeFor(businessId: string, now: Date): Promise<void> {
    const stores = await this.billing.storeNoticeState(businessId, now);
    if (!stores.length) return;
    const claimed = await this.dbService.db
      .insert(billingNotices)
      .values({
        businessId,
        periodEnd: new Date(`${businessDay(now)}T00:00:00Z`),
        kind: 'stores',
      })
      .onConflictDoNothing()
      .returning({kind: billingNotices.kind});
    if (!claimed.length) return;
    this.billing.sendBilling(
      businessId,
      branchNoticeText({stores}),
      {kind: 'stores', stores},
      [[billingNoticeButton({isTrial: false})]],
    );
  }

  private async noticeFor(businessId: string, now: Date): Promise<void> {
    const s = await this.billing.noticeState(businessId);
    const kind = NOTICE_KIND[s.stage];
    if (!kind || !s.endDate) return;
    if (
      kind === 'restricted' &&
      now.getTime() - graceEndsAt(s.endDate).getTime() >
        RESTRICTED_NOTICE_WINDOW_MS
    ) {
      return;
    }

    const claimed = await this.dbService.db
      .insert(billingNotices)
      .values({businessId, periodEnd: s.endDate, kind})
      .onConflictDoNothing()
      .returning({kind: billingNotices.kind});
    if (!claimed.length) return;

    const notice = this.billing.noticePayload({...s, endDate: s.endDate}, kind);
    this.billing.sendBilling(businessId, notice.text, notice.data, notice.buttons);
  }
}

import {Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {DatabaseService} from '../database/database.service';
import {billingNotices} from '../database/schema';
import {BillingService} from './billing.service';
import {
  REMINDER_DAYS,
  graceEndsAt,
  tashkentHour,
  type BillingStage,
} from './billing';
import {billingNoticeText, type BillingNoticeKind} from './billing-text';

const DAY_MS = 86_400_000;

// Renewals run only in the daytime (§4): a renewal sends a message, and the
// grace period makes a few hours' delay harmless.
const RENEW_FROM_HOUR = 8;
const RENEW_UNTIL_HOUR = 22;

const NOTICE_KIND: Partial<Record<BillingStage, BillingNoticeKind>> = {
  reminder: 'd7',
  urgent: 'd3',
  grace: 'expired',
  restricted: 'restricted',
};

// "The day the plan was restricted" — a shop that went restricted long ago
// (before this feature, or a churned one) gets no fresh notice for it.
const RESTRICTED_NOTICE_WINDOW_MS = 2 * DAY_MS;

/**
 * The billing schedules (OBUNA-TOLOV.md §4). `BILLING_CRON=off` disables both
 * — for a local server pointed at a shared database.
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

    this.billing.sendBilling(
      businessId,
      billingNoticeText({
        kind,
        isTrial: s.isTrial,
        daysLeft: s.daysLeft ?? 0,
        endDate: s.endDate,
        amountDue: s.amountDue,
        planName: s.planName,
      }),
      {
        kind,
        isTrial: s.isTrial,
        daysLeft: s.daysLeft,
        amountDue: s.amountDue,
        planName: s.planName,
      },
    );
  }
}

import {Injectable} from '@nestjs/common';
import {eq, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {businesses} from '../database/schema';
import {IBusiness} from '../business/types';
import {
  buildOnboardingState,
  OnboardingFacts,
  OnboardingState,
  onboardingStepsFor,
} from './onboarding.steps';
import {QueriedStep, stepExists, storeFact} from './onboarding.conditions';

@Injectable()
export class OnboardingService {
  constructor(private readonly dbService: DatabaseService) {}

  /**
   * The checklist for the caller's business. `business` is the row
   * JwtAuthGuard just read (uncached), so dismissal and the storefront flags
   * cost nothing extra; the remaining steps are one round trip.
   *
   * Steps are computed even when dismissed so the answer is always true — on
   * an established shop each EXISTS hits a row at once, so it stays cheap.
   */
  async getState(business: IBusiness): Promise<OnboardingState> {
    const facts = await this.readFacts(business);
    return buildOnboardingState(
      business.businessType,
      facts,
      business.onboardingDismissedAt != null,
    );
  }

  async dismiss(business: IBusiness): Promise<OnboardingState> {
    // Keep the first dismissal time: repeating the call changes nothing.
    const [row] = await this.dbService.db
      .update(businesses)
      .set({
        onboardingDismissedAt: sql`COALESCE(${businesses.onboardingDismissedAt}, now())`,
      })
      .where(eq(businesses.id, business.id))
      .returning({onboardingDismissedAt: businesses.onboardingDismissedAt});
    return this.getState({
      ...business,
      onboardingDismissedAt: row?.onboardingDismissedAt ?? new Date(),
    });
  }

  /** Brings a hidden checklist back; a no-op when it was never hidden. */
  async restore(business: IBusiness): Promise<OnboardingState> {
    await this.dbService.db
      .update(businesses)
      .set({onboardingDismissedAt: null})
      .where(eq(businesses.id, business.id));
    return this.getState({...business, onboardingDismissedAt: null});
  }

  private async readFacts(business: IBusiness): Promise<OnboardingFacts> {
    const facts: OnboardingFacts = {
      // Free: it is on the business row already.
      store: storeFact(business),
    };

    const queried = onboardingStepsFor(business.businessType)
      .map((s) => s.key)
      .filter((k): k is QueriedStep => k !== 'store');
    if (queried.length === 0) return facts;

    // Conditions live in onboarding.conditions.ts, shared with the platform
    // console's setup column. Each one is an index probe on business_id.
    const id = sql`${business.id}`;
    const columns = sql.join(
      queried.map(
        (k) => sql`${stepExists(k, business.businessType)(id)} AS ${sql.identifier(k)}`,
      ),
      sql`, `,
    );
    const res = (await this.dbService.db.execute(sql`SELECT ${columns}`)) as unknown;
    // db.execute() returns a bare row array or a { rows } object depending on
    // the driver — normalise both.
    const rows =
      (res as {rows?: Record<string, unknown>[]}).rows ??
      (res as Record<string, unknown>[]);
    const row = rows?.[0] ?? {};
    for (const k of queried) facts[k] = row[k] === true;
    return facts;
  }
}

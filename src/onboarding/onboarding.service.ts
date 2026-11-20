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
import {GlobalCatalogService} from '../category/global-catalog.service';
import {
  buildWizardState,
  isSetupStatus,
  MAX_DIRECTIONS,
  SetupWizardState,
  wizardAppliesTo,
} from './onboarding.wizard';
import type {SaveSetupWizardDto} from './dto/setup-wizard.dto';

/** GET /onboarding: the "Boshlash" card plus the setup wizard's state. */
export interface OnboardingView extends OnboardingState {
  wizard: SetupWizardState;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly catalog: GlobalCatalogService,
  ) {}

  /**
   * The checklist for the caller's business. `business` is the row
   * JwtAuthGuard just read (uncached), so dismissal and the storefront flags
   * cost nothing extra; the remaining steps are one round trip.
   *
   * Steps are computed even when dismissed so the answer is always true — on
   * an established shop each EXISTS hits a row at once, so it stays cheap.
   */
  async getState(business: IBusiness): Promise<OnboardingView> {
    const [facts, catalogueEmpty] = await Promise.all([
      this.readFacts(business),
      this.catalogueEmpty(business),
    ]);
    return {
      ...buildOnboardingState(
        business.businessType,
        facts,
        business.onboardingDismissedAt != null,
      ),
      wizard: buildWizardState(business, catalogueEmpty),
    };
  }

  /**
   * Remembers the wizard's progress: the step reached, the lines of trade
   * picked (known visible keys only, at most three) or typed, and finally
   * 'done' or 'skipped'. Omitted fields stay as they are.
   */
  async saveWizard(business: IBusiness, dto: SaveSetupWizardDto): Promise<OnboardingView> {
    const patch: Partial<typeof businesses.$inferInsert> = {};
    if (dto.step !== undefined) patch.setupStep = dto.step;
    if (dto.status !== undefined && isSetupStatus(dto.status)) patch.setupStatus = dto.status;
    if (dto.directions !== undefined) {
      const snap = await this.catalog.snapshot();
      const visible = new Set(snap.directions.filter((d) => !d.isHidden).map((d) => d.key));
      patch.directions = [...new Set(dto.directions.map((d) => d.trim()))]
        .filter((d) => visible.has(d))
        .slice(0, MAX_DIRECTIONS);
    }
    if (dto.directionText !== undefined) {
      const text = dto.directionText.replace(/\s+/g, ' ').trim();
      patch.directionText = text ? text.slice(0, 200) : null;
    }
    if (Object.keys(patch).length === 0) return this.getState(business);

    const [row] = await this.dbService.db
      .update(businesses)
      .set(patch)
      .where(eq(businesses.id, business.id))
      .returning({
        setupStatus: businesses.setupStatus,
        setupStep: businesses.setupStep,
        directions: businesses.directions,
        directionText: businesses.directionText,
      });
    return this.getState({...business, ...row});
  }

  /**
   * No live category and no product: a shop that has started on its own is
   * not interrupted by the wizard. Skipped (no query) when the answer cannot
   * matter — a kitchen, or a wizard already finished or put off.
   */
  private async catalogueEmpty(business: IBusiness): Promise<boolean> {
    if (!wizardAppliesTo(business.businessType) || business.setupStatus != null) return false;
    const res = (await this.dbService.db.execute(sql`
      SELECT NOT EXISTS (SELECT 1 FROM products p WHERE p.business_id = ${business.id})
         AND NOT EXISTS (
           SELECT 1 FROM categories c WHERE c.business_id = ${business.id} AND NOT c.is_deleted
         ) AS empty
    `)) as unknown;
    const rows =
      (res as {rows?: Record<string, unknown>[]}).rows ??
      (res as Record<string, unknown>[]);
    return rows?.[0]?.empty === true;
  }

  async dismiss(business: IBusiness): Promise<OnboardingView> {
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
  async restore(business: IBusiness): Promise<OnboardingView> {
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

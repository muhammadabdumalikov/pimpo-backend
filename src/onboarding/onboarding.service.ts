import {Injectable} from '@nestjs/common';
import {asc, eq, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {businesses, roles} from '../database/schema';
import {IBusiness} from '../business/types';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {RoleService} from '../role/role.service';
import {StaffService} from '../staff/staff.service';
import {BranchService} from '../branch/branch.service';
import {CASHIER_PERMISSIONS} from '../permission/role-presets';
import type {CatalogLocale} from '../category/category-locale';
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
  CASHIER_ROLE_NAMES,
  isCashierRoleName,
  isSetupStatus,
  MAX_DIRECTIONS,
  SetupWizardState,
  staffStepAppliesTo,
  wizardAppliesTo,
} from './onboarding.wizard';
import type {SaveSetupWizardDto} from './dto/setup-wizard.dto';
import type {CreateWizardCashierDto} from './dto/wizard-cashier.dto';

/** GET /onboarding: the "Boshlash" card plus the setup wizard's state. */
export interface OnboardingView extends OnboardingState {
  wizard: SetupWizardState;
}

/** POST /onboarding/wizard/cashier: the seller made and the role it got. */
export interface WizardCashierResult {
  staff: {id: string; name: string; login: string};
  role: {id: string; name: string};
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly catalog: GlobalCatalogService,
    private readonly roleService: RoleService,
    private readonly staffService: StaffService,
    private readonly branchService: BranchService,
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
   * "Sotuvchingiz bormi?": a seller who signs in with a login and password,
   * on a ready-made cashier role, so the owner never opens the roles screen.
   *
   * The account goes through StaffService.create unchanged — seat limit, login
   * uniqueness, password hashing and its error codes all apply as on
   * POST /staff. It lands in the default branch: without `branch:all` a staff
   * account is pinned to its own store anyway, and this makes that explicit.
   *
   * Not one transaction: RoleService and StaffService write on their own
   * connection. A refused account (login taken, no seat) can leave the role
   * behind with nobody on it; the next attempt reuses it by name.
   */
  async addCashier(
    business: IBusiness,
    dto: CreateWizardCashierDto,
    locale: CatalogLocale,
  ): Promise<WizardCashierResult> {
    if (!staffStepAppliesTo(business.businessType)) {
      throw new AppException(ErrorCode.SETUP_STEP_NOT_AVAILABLE, {step: 'staff'});
    }
    const role = await this.cashierRole(business.id, locale);
    const branch = await this.branchService.ensureDefault(business.id);
    const member = await this.staffService.create(business.id, {
      name: dto.name,
      hasAccount: true,
      login: dto.login,
      password: dto.password,
      roleId: role.id,
      position: role.name,
      branchId: branch.id,
    });
    return {
      staff: {id: member.id, name: member.name, login: member.login ?? dto.login},
      role,
    };
  }

  /**
   * The shop's own cashier role if it keeps one (by name, in any of the
   * dashboard languages — its permissions are the owner's and stay as they
   * are), otherwise a new one in the request language with the cashier preset.
   * A deactivated role is passed over: its staff could not sign in.
   */
  private async cashierRole(
    businessId: string,
    locale: CatalogLocale,
  ): Promise<{id: string; name: string}> {
    const existing = await this.findCashierRole(businessId);
    if (existing) return existing;
    try {
      const role = await this.roleService.create(businessId, {
        name: CASHIER_ROLE_NAMES[locale],
        permissions: [...CASHIER_PERMISSIONS],
      });
      return {id: role.id, name: role.name};
    } catch (err) {
      // A double tap made it a moment ago: use that one.
      if (err instanceof AppException && err.code === ErrorCode.ROLE_NAME_EXISTS) {
        const raced = await this.findCashierRole(businessId);
        if (raced) return raced;
      }
      throw err;
    }
  }

  // Matched in code, not with SQL lower(): under a C locale that folds ASCII
  // only ("Кассир" would miss), and a shop has a handful of roles.
  private async findCashierRole(
    businessId: string,
  ): Promise<{id: string; name: string} | null> {
    const rows = await this.dbService.db
      .select({id: roles.id, name: roles.name, isActive: roles.isActive})
      .from(roles)
      .where(eq(roles.businessId, businessId))
      .orderBy(asc(roles.createdAt));
    const hit = rows.find((r) => r.isActive && isCashierRoleName(r.name));
    return hit ? {id: hit.id, name: hit.name} : null;
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

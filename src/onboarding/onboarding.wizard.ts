/**
 * The setup wizard (AI-SOZLASH.md §2): a few questions that get a new shop
 * ready — what it sells, its categories, a seller, where its products are.
 * Pure helpers; OnboardingService reads and writes the business row.
 */

/** Wizard steps in order. `staff` is skipped for an online seller. */
export const SETUP_WIZARD_STEPS = ['direction', 'categories', 'staff', 'products'] as const;
export type SetupWizardStep = (typeof SETUP_WIZARD_STEPS)[number];

export const SETUP_STATUSES = ['done', 'skipped'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

/** Most lines of trade an owner may pick (Q13). */
export const MAX_DIRECTIONS = 3;

export interface SetupWizardState {
  /**
   * Open the wizard by itself on the next visit: a shop or an online seller
   * that has never finished nor skipped it and has no category and no product
   * yet. The owner can still open it by hand when this is false.
   */
  eligible: boolean;
  status: SetupStatus | null;
  step: SetupWizardStep | null;
  directions: string[];
  directionText: string | null;
}

/** A kitchen sets up its menu its own way (Q7); everyone else gets the wizard. */
export function wizardAppliesTo(businessType: string | null | undefined): boolean {
  return businessType !== 'food';
}

export function isSetupStatus(v: unknown): v is SetupStatus {
  return SETUP_STATUSES.includes(v as SetupStatus);
}

export function isSetupWizardStep(v: unknown): v is SetupWizardStep {
  return SETUP_WIZARD_STEPS.includes(v as SetupWizardStep);
}

export function buildWizardState(
  row: {
    businessType: string | null;
    setupStatus: string | null;
    setupStep: string | null;
    directions: string[] | null;
    directionText: string | null;
  },
  catalogueEmpty: boolean,
): SetupWizardState {
  const status = isSetupStatus(row.setupStatus) ? row.setupStatus : null;
  return {
    eligible: wizardAppliesTo(row.businessType) && status === null && catalogueEmpty,
    status,
    step: isSetupWizardStep(row.setupStep) ? row.setupStep : null,
    directions: row.directions ?? [],
    directionText: row.directionText,
  };
}

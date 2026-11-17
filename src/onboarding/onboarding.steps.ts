/**
 * The "Boshlash" checklist: which steps a business has, in what order, and
 * when it counts as done. Pure on purpose — the per-business service feeds it
 * facts read from real data, and a later bulk "stage of every shop" read for
 * the platform console can feed it the same facts per row.
 */

export const ONBOARDING_STEP_KEYS = [
  'product',
  'stock',
  'store',
  'sale',
  'staff',
  'telegram',
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];
/** The steps that are required for some business type (see STEPS). */
export type OnboardingRequiredStepKey = Exclude<OnboardingStepKey, 'staff' | 'telegram'>;

export interface OnboardingStepDef {
  key: OnboardingStepKey;
  optional: boolean;
}

const req = (key: OnboardingStepKey): OnboardingStepDef => ({key, optional: false});
const opt = (key: OnboardingStepKey): OnboardingStepDef => ({key, optional: true});

// Ordered toward the first sale. A kitchen has no stock step: a dish holds no
// stock of its own (FASTFOOD.md §2), its ingredients do, and a shop can sell
// before it has received anything. An online seller has no till and no staff,
// but nothing sells until the storefront is on.
const STEPS: Record<'retail' | 'food' | 'online', OnboardingStepDef[]> = {
  retail: [req('product'), req('stock'), req('sale'), opt('staff'), opt('telegram')],
  food: [req('product'), req('sale'), opt('staff'), opt('telegram')],
  online: [req('product'), req('store'), req('sale'), opt('telegram')],
};

/** Step list for a businesses.business_type; unknown values read as retail. */
export function onboardingStepsFor(businessType: string | null | undefined): OnboardingStepDef[] {
  const type = businessType === 'food' || businessType === 'online' ? businessType : 'retail';
  return STEPS[type];
}

/** What is true about the business, one flag per step key. */
export type OnboardingFacts = Partial<Record<OnboardingStepKey, boolean>>;

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  optional: boolean;
}

export interface OnboardingState {
  businessType: string;
  steps: OnboardingStep[];
  completed: boolean;
  dismissed: boolean;
}

export function buildOnboardingState(
  businessType: string,
  facts: OnboardingFacts,
  dismissed: boolean,
): OnboardingState {
  // A sale settles every step before it. Nothing sells without a product, and
  // a shop that has sold its last unit — or never keeps stock at all — is
  // running: it must not be sent back to "enter your stock", nor land in the
  // team's list of shops that never got started.
  const sold = facts.sale === true;
  const steps = onboardingStepsFor(businessType).map((s) => ({
    key: s.key,
    done: facts[s.key] === true || (sold && !s.optional),
    optional: s.optional,
  }));
  return {
    businessType,
    steps,
    // Optional steps are suggestions; the card is finished once the shop can
    // sell and has sold.
    completed: steps.every((s) => s.optional || s.done),
    dismissed,
  };
}

/** How far a shop has got: the platform console's setup column. */
export interface OnboardingSetup {
  /** The required step the shop is stuck on (the first one not done), or null once every required step is done. */
  next: OnboardingRequiredStepKey | null;
  /** Required steps done / required steps in total, for that business type. */
  done: number;
  total: number;
}

/**
 * The card's required steps, summed up. Built from buildOnboardingState so
 * `next === null` exactly when the card reads `completed`. Dismissal plays no
 * part: a shop that hid the card is still where it is.
 */
export function onboardingSetup(businessType: string, facts: OnboardingFacts): OnboardingSetup {
  const required = buildOnboardingState(businessType, facts, false).steps.filter(
    (s) => !s.optional,
  );
  const next = required.find((s) => !s.done);
  return {
    next: next ? (next.key as OnboardingRequiredStepKey) : null,
    done: required.filter((s) => s.done).length,
    total: required.length,
  };
}

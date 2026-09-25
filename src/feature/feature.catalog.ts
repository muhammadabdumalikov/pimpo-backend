/**
 * The canonical list of feature flags — features that are rolling out to
 * chosen do'konlar before (or instead of) everyone.
 *
 * Hard rules:
 *  1. A key lands here together with the code that checks it (@RequireFeature
 *     on the endpoints, useFeature() in the UI). The platform console lists
 *     exactly this catalogue, and a switch there that changes nothing is worse
 *     than no switch.
 *  2. Keys are snake_case and stable while the flag lives — they are stored
 *     verbatim in business_feature_flags.
 *  3. A flag is temporary. Once a feature is on for everyone and staying, delete
 *     the entry and its checks; leftover rows in the tables are harmless.
 *
 * Not a flag: what a shop PAYS for. That is the plan tier (@MinTier /
 * PlanTierGuard), a separate axis — a pro-only beta uses both decorators.
 *
 * Adding one:
 *   { key: 'loyalty_checkout', name: "Kassada bonus to'lash",
 *     description: 'Checkout earns and redeems loyalty balance.' },
 */
export interface FeatureDefinition {
  key: string;
  /** Uzbek label for the platform console. */
  name: string;
  /** What turning it on changes, for whoever flips it. */
  description: string;
}

export const FEATURE_CATALOG = [
  {
    key: 'defective_store',
    name: 'Yaroqsiz tovarlar ombori',
    description:
      'Yaroqsiz tovarlarni alohida omborda saqlash: mijoz qaytargan yaroqsiz ' +
      "tovar zarar bo'lib chiqib ketmaydi, omborga tushadi va u yerdan " +
      'hisobdan chiqariladi, sotuvga qaytadi yoki yetkazib beruvchiga ' +
      "qaytariladi. O'chiq do'konda yaroqsiz qaytarish avvalgidek zarar.",
  },
] as const satisfies readonly FeatureDefinition[];

/** Every key the code may check. `never` while the catalogue is empty. */
export type FeatureKey = (typeof FEATURE_CATALOG)[number]['key'];

const BY_KEY: ReadonlyMap<string, FeatureDefinition> = new Map(
  (FEATURE_CATALOG as readonly FeatureDefinition[]).map((f) => [f.key, f]),
);

/** The catalogue as plain definitions (the typed tuple is only for keys). */
export const FEATURES: readonly FeatureDefinition[] = [...BY_KEY.values()];

export function findFeature(key: string): FeatureDefinition | undefined {
  return BY_KEY.get(key);
}

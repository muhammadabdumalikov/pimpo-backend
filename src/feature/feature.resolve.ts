export const ROLLOUTS = ['off', 'selected', 'all'] as const;
export type Rollout = (typeof ROLLOUTS)[number];

/**
 * Whether a flag is on for one business.
 *
 * `override` is that business's row in business_feature_flags, or undefined
 * when it has none:
 *   off       → never. The kill switch: a broken beta is switched off for
 *               everyone at once, and the beta list survives for later.
 *   selected  → only an explicit `true`.
 *   all       → everyone except an explicit `false`.
 */
export function isFeatureOn(
  rollout: Rollout,
  override: boolean | undefined,
): boolean {
  switch (rollout) {
    case 'selected':
      return override === true;
    case 'all':
      return override !== false;
    default:
      return false;
  }
}

/** Unknown/legacy strings from the DB read as the safe value. */
export function asRollout(value: string | null | undefined): Rollout {
  return (ROLLOUTS as readonly string[]).includes(value ?? '')
    ? (value as Rollout)
    : 'off';
}

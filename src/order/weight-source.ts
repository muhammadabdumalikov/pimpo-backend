/**
 * Where a weighed line's amount came from — the owner's audit trail for the
 * live scale (TAROZI.md §8).
 *
 *  - 'scale'  — read off the till's live scale and left alone.
 *  - 'label'  — parsed from a label-printing scale's barcode.
 *  - 'manual' — typed or stepped by hand on a till that HAS a live scale
 *               configured (connected or not). This is the value worth a look.
 *  - null     — no live scale at that till; hand entry is simply how it works.
 *
 * The till decides the value; the server cannot tell a real reading from a
 * typed one. What it does enforce is that the column only ever describes a
 * kilogram line, so a stray value on a piece or litre line can't pollute the
 * "manual weight" filter.
 */
import {SYSTEM_KG_UNIT_ID} from '../unit/unit.service';

export const WEIGHT_SOURCES = ['scale', 'label', 'manual'] as const;
export type WeightSource = (typeof WEIGHT_SOURCES)[number];

/**
 * The value to store for a line: the till's claim when the product is sold in
 * kilograms, otherwise null. Pre-units products (no unitId) count as kg when
 * their legacy quantityType says so — migration 0040 moved those onto the
 * system kg unit, so this is only a belt for rows it missed.
 */
export function weightSourceFor(
  product: {unitId: string | null; quantityType: string | null},
  requested: WeightSource | null | undefined,
): WeightSource | null {
  if (!requested) return null;
  const isKg =
    product.unitId === SYSTEM_KG_UNIT_ID ||
    (product.unitId == null && product.quantityType === 'kg');
  return isKg ? requested : null;
}

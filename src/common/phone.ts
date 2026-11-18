/**
 * Uzbek phone numbers, as an owner types them at sign-up: "+998 90 123 45 67",
 * "998901234567", "90 123-45-67", "8 90 1234567" are all the same number.
 */

/** Loose shape check for DTOs: digits with the usual separators. */
export const PHONE_INPUT_RE = /^\+?[\d\s()-]{9,20}$/;

/**
 * The canonical form stored in the database: "+998" and nine digits. Returns
 * null when the input is not an Uzbek number (wrong length or country code).
 */
/**
 * A buyer's phone as an order stores it: canonical when it is an Uzbek number
 * (so search and links agree), as typed otherwise; undefined when empty.
 */
export function storedPhone(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return normalizeUzPhone(trimmed) ?? trimmed;
}

export function normalizeUzPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  // The old trunk prefix: "8 90 123 45 67".
  if (digits.length === 10 && digits.startsWith('8')) digits = digits.slice(1);
  if (digits.length === 9) digits = `998${digits}`;
  if (digits.length !== 12 || !digits.startsWith('998')) return null;
  return `+${digits}`;
}

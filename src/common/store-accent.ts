// A shop's storefront accent colour.
//
// The owner picks one key from a fixed palette rather than any colour: the
// storefront sets white text on the accent (buttons, the cart badge), and
// every colour behind these keys was checked for at least 4.5:1 contrast with
// white. The colours themselves live in the storefront (pimpo-ecommerce); the
// backend only stores and validates the key. null = the default KPOS colour.

export const STORE_ACCENTS = [
  'blue',
  'violet',
  'rose',
  'red',
  'orange',
  'green',
  'teal',
  'graphite',
] as const;

export type StoreAccent = (typeof STORE_ACCENTS)[number];

/**
 * The accent as stored: a palette key, or null when blank / cleared.
 * Returns undefined for anything else so the caller can reject it.
 */
export function readStoreAccent(
  raw: string | null | undefined,
): StoreAccent | null | undefined {
  const key = raw?.trim().toLowerCase();
  if (!key) return null;
  return (STORE_ACCENTS as readonly string[]).includes(key)
    ? (key as StoreAccent)
    : undefined;
}

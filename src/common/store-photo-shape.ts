// How a shop's product photos are drawn on the storefront.
//
// 'square' is today's look and the default; 'portrait' draws the cards 4:5,
// which suits clothes shops. The storefront (pimpo-ecommerce) does the
// drawing; the backend only stores and validates the key. The default is
// stored as null, so only 'portrait' ever reaches the column.

export const STORE_PHOTO_SHAPES = ['square', 'portrait'] as const;

export type StorePhotoShape = (typeof STORE_PHOTO_SHAPES)[number];

/**
 * The shape as stored: 'portrait', or null for blank / cleared / 'square'.
 * Returns undefined for anything else so the caller can reject it.
 */
export function readStorePhotoShape(
  raw: string | null | undefined,
): 'portrait' | null | undefined {
  const key = raw?.trim().toLowerCase();
  if (!key || key === 'square') return null;
  return key === 'portrait' ? 'portrait' : undefined;
}

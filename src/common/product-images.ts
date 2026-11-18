// A product's photos.
//
// `products.image` is THE main photo — every list, the till, receipts, the
// apps, thumbnails and the shared barcode catalog read it and nothing else.
// `products.extra_images` holds only the additional photos, in the order the
// owner put them. The two are never kept in sync: the gallery a shopper sees
// is worked out on read (productGallery), so a client that only knows `image`
// can change the main photo without ever losing the extras.

/** Most additional photos a card carries next to its main `image`. */
export const MAX_EXTRA_PRODUCT_IMAGES = 7;

/** Longest photo URL accepted — the same cap as products.image (varchar 500). */
export const PRODUCT_IMAGE_MAX_LENGTH = 500;

/**
 * The extra photos as they are stored: trimmed, blanks and repeats dropped,
 * any copy of the main photo dropped (it is shown first anyway), at most
 * MAX_EXTRA_PRODUCT_IMAGES kept. Nothing left → [].
 */
export function cleanExtraImages(
  raw: readonly unknown[] | null | undefined,
  mainImage: string | null | undefined,
): string[] {
  if (!Array.isArray(raw)) return [];
  const main = (mainImage ?? '').trim();
  const out: string[] = [];
  for (const entry of raw) {
    const url = typeof entry === 'string' ? entry.trim() : '';
    if (!url || url === main || out.includes(url)) continue;
    out.push(url);
    if (out.length === MAX_EXTRA_PRODUCT_IMAGES) break;
  }
  return out;
}

/**
 * The full gallery a shopper sees: the main photo first, then the extras, with
 * blanks and repeats dropped. A card with no photo at all → [].
 */
export function productGallery(
  image: string | null | undefined,
  extraImages: readonly unknown[] | null | undefined,
): string[] {
  const out: string[] = [];
  for (const entry of [image, ...(Array.isArray(extraImages) ? extraImages : [])]) {
    const url = typeof entry === 'string' ? entry.trim() : '';
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

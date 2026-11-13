// sharp is CommonJS at runtime; see ai/image/packshot-image.ts for why require().
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const sharp: typeof import('sharp').default = require('sharp');

/**
 * A picture's small copy lives next to it: `<key>.t320.webp` (RASM-THUMB.md).
 * A convention instead of a column, because a picture's URL is copied around
 * (barcode lookup, shared-picture rewrites, console approvals) and the small
 * copy then follows it for free. Clients build the same name and fall back to
 * the original when it is missing (old or foreign pictures).
 */
export const THUMB_SUFFIX = '.t320.webp';
const THUMB_PX = 320;
const THUMB_QUALITY = 75;

export function thumbKey(key: string): string {
  return `${key}${THUMB_SUFFIX}`;
}

/**
 * 320px square WebP on white (~6–9 KB) — grid tiles, lists, the till. A
 * smaller picture is centred on the canvas, not stretched.
 */
export async function makeThumbWebp(source: Buffer): Promise<Buffer> {
  return sharp(source, {failOn: 'none'})
    .rotate()
    .flatten({background: '#ffffff'})
    .resize(THUMB_PX, THUMB_PX, {
      fit: 'contain',
      background: '#ffffff',
      withoutEnlargement: true,
    })
    .webp({quality: THUMB_QUALITY, effort: 6})
    .toBuffer();
}

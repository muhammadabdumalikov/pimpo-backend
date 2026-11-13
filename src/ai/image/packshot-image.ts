import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import type {InlinePhoto} from './gemini-image.client';

// sharp is CommonJS at runtime (module.exports = the function), but its
// `types` field points at the ESM declarations, which this project's node10
// resolution reads as a default export. require() is the runtime truth.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const sharp: typeof import('sharp').default = require('sharp');
export {sharp};

/** Longest side of the photo sent to the model; more detail is not read. */
const INPUT_PHOTO_PX = 1536;
/**
 * The stored packshot: a square WebP. Gemini hands back a ~1–1.5 MB PNG; no
 * screen shows a product above ~400 CSS px (800 on a retina phone), so 800px
 * at q80 with sharp's slowest/best encoder (effort 6) lands at ~25–45 KB —
 * about 30× smaller than the PNG and ~45% under the old 1024/q86, with no
 * visible loss on a flat white packshot. Measured 2026-11-13.
 */
const OUTPUT_PX = 800;
const OUTPUT_WEBP_QUALITY = 80;
const OUTPUT_WEBP_EFFORT = 6;

/** A source picture as the controller hands it over. */
export interface SourcePhoto {
  data: Buffer;
  mimeType: string;
}

/**
 * The shop's photo, upright (phones store rotation in EXIF) and no larger than
 * the model reads. HEIC that sharp's prebuilt libheif cannot decode is passed
 * through — Gemini reads HEIC itself.
 */
export async function prepareInputPhoto(
  source: SourcePhoto,
): Promise<InlinePhoto> {
  try {
    const data = await sharp(source.data, {failOn: 'none'})
      .rotate()
      .resize(INPUT_PHOTO_PX, INPUT_PHOTO_PX, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({quality: 88})
      .toBuffer();
    return {data, mimeType: 'image/jpeg'};
  } catch {
    if (/^image\/hei[cf]$/.test(source.mimeType)) {
      return {data: source.data, mimeType: source.mimeType};
    }
    throw new AppException(ErrorCode.AI_IMAGE_PHOTO_UNREADABLE);
  }
}

/**
 * Square 800 WebP on white — what the till, the list and the storefront load.
 * Never upscales a smaller source; metadata (EXIF, ICC) is dropped.
 */
export async function toPackshotWebp(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .flatten({background: '#ffffff'})
    .resize(OUTPUT_PX, OUTPUT_PX, {
      fit: 'contain',
      background: '#ffffff',
      withoutEnlargement: true,
    })
    .webp({
      quality: OUTPUT_WEBP_QUALITY,
      effort: OUTPUT_WEBP_EFFORT,
      smartSubsample: true,
    })
    .toBuffer();
}

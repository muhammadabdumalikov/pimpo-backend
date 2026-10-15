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
/** The stored packshot: square, WebP, small enough for the till grid. */
const OUTPUT_PX = 1024;
const OUTPUT_WEBP_QUALITY = 86;

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

/** Square 1024 WebP on white — what the till, the list and the storefront load. */
export async function toPackshotWebp(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .flatten({background: '#ffffff'})
    .resize(OUTPUT_PX, OUTPUT_PX, {fit: 'contain', background: '#ffffff'})
    .webp({quality: OUTPUT_WEBP_QUALITY})
    .toBuffer();
}

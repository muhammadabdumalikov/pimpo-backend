import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import type {StorageService} from '../storage/storage.service';
import {generateId} from '../utils/uuid';

// sharp is CommonJS at runtime; see ai/image/packshot-image.ts for why require().
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const sharp: typeof import('sharp').default = require('sharp');

/**
 * The storefront's own pictures: the banners, the logo and the cover. One
 * upload path for all three — same accepted types, same size cap, same S3
 * folder per shop — differing only in the shape they are cut to.
 */

/** Largest upload accepted, before it is cut down and re-encoded. */
export const MAX_STORE_IMAGE_BYTES = 10 * 1024 * 1024;
const STORE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

export type StoreImageKind = 'banner' | 'logo' | 'cover';

/**
 * - banner: 2:1, cropped to fit, on white.
 * - logo: square, the whole picture fitted inside it, transparency kept.
 * - cover: 3:1, cropped to fit, on white.
 */
const SHAPES: Record<
  StoreImageKind,
  {width: number; height: number; fit: 'cover' | 'contain'; keepAlpha: boolean}
> = {
  banner: {width: 1600, height: 800, fit: 'cover', keepAlpha: false},
  logo: {width: 512, height: 512, fit: 'contain', keepAlpha: true},
  cover: {width: 1800, height: 600, fit: 'cover', keepAlpha: false},
};

/** Every picture of one shop's storefront lives under this S3 folder. */
export function storeImagePrefix(businessId: string): string {
  return `banners/${businessId}/`;
}

/** Cuts the upload to its kind's shape, stores it as WebP, returns its URL. */
export async function uploadStoreImage(
  storage: StorageService,
  businessId: string,
  kind: StoreImageKind,
  file: {buffer: Buffer; mimetype: string},
): Promise<{url: string}> {
  if (!storage.isEnabled()) {
    throw new AppException(ErrorCode.STORAGE_NOT_CONFIGURED);
  }
  const webp = await toStoreWebp(kind, file);
  const name = kind === 'banner' ? generateId() : `${kind}-${generateId()}`;
  const {url} = await storage.upload(webp, {
    key: `${storeImagePrefix(businessId)}${name}.webp`,
    contentType: 'image/webp',
  });
  return {url};
}

/** The re-encoded picture; INVALID_FILE_TYPE for anything sharp cannot read. */
export async function toStoreWebp(
  kind: StoreImageKind,
  file: {buffer: Buffer; mimetype: string},
): Promise<Buffer> {
  const invalid = () =>
    new AppException(ErrorCode.INVALID_FILE_TYPE, {
      allowed: 'JPEG, PNG, WebP',
    });
  if (!STORE_IMAGE_MIMES.includes(file.mimetype)) throw invalid();
  const shape = SHAPES[kind];
  try {
    let pipeline = sharp(file.buffer, {failOn: 'none'}).rotate();
    if (!shape.keepAlpha) pipeline = pipeline.flatten({background: '#ffffff'});
    return await pipeline
      .resize(shape.width, shape.height, {
        fit: shape.fit,
        // "attention" picks the busiest region to keep; it only applies to a crop.
        position: shape.fit === 'cover' ? 'attention' : 'centre',
        background: {r: 0, g: 0, b: 0, alpha: 0},
        withoutEnlargement: false,
      })
      .webp({quality: 80, effort: 6, smartSubsample: true})
      .toBuffer();
  } catch {
    throw invalid();
  }
}

/**
 * Whether `url` is a picture this shop uploaded through uploadStoreImage: the
 * storefront must never be made to load an address a client chose.
 */
export function isOwnStoreImage(
  storage: StorageService,
  businessId: string,
  url: string,
): boolean {
  const key = storage.keyFromUrl(url);
  return !!key && key.startsWith(storeImagePrefix(businessId));
}

import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import type {StorageService} from '../storage/storage.service';
import {isOwnStoreImage, toStoreWebp, uploadStoreImage} from './store-images';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const sharp: typeof import('sharp').default = require('sharp');

const png = (width: number, height: number, alpha = false) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? {r: 200, g: 0, b: 0, alpha: 0.5} : '#c80000',
    },
  })
    .png()
    .toBuffer();

const BASE = 'https://s3.example.test/KPOS/';
function fakeStorage(enabled = true) {
  const upload = jest.fn((_buf: Buffer, opts: {key: string}) =>
    Promise.resolve({url: `${BASE}${opts.key}`, key: opts.key}),
  );
  const storage = {
    isEnabled: () => enabled,
    upload,
    keyFromUrl: (url: string) =>
      url.startsWith(BASE) ? url.slice(BASE.length) : null,
  } as unknown as StorageService;
  return {storage, upload};
}

describe('toStoreWebp', () => {
  it.each([
    ['banner', 1600, 800],
    ['logo', 512, 512],
    ['cover', 1800, 600],
  ] as const)('cuts a %s to %ix%i WebP', async (kind, width, height) => {
    const out = await toStoreWebp(kind, {
      buffer: await png(1000, 700),
      mimetype: 'image/png',
    });
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({format: 'webp', width, height});
  });

  it('keeps a logo transparent, puts a cover on white', async () => {
    const file = {buffer: await png(300, 100, true), mimetype: 'image/png'};
    expect(
      (await sharp(await toStoreWebp('logo', file)).metadata()).hasAlpha,
    ).toBe(true);
    expect(
      (await sharp(await toStoreWebp('cover', file)).metadata()).hasAlpha,
    ).toBe(false);
  });

  it('refuses other types and unreadable files', async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: AppException) => e.code,
      );
    expect(
      await code(
        toStoreWebp('logo', {buffer: await png(10, 10), mimetype: 'image/gif'}),
      ),
    ).toBe(ErrorCode.INVALID_FILE_TYPE);
    expect(
      await code(
        toStoreWebp('logo', {
          buffer: Buffer.from('nope'),
          mimetype: 'image/png',
        }),
      ),
    ).toBe(ErrorCode.INVALID_FILE_TYPE);
  });
});

describe('uploadStoreImage', () => {
  it("stores logo and cover in the shop's banner folder, named by kind", async () => {
    const {storage, upload} = fakeStorage();
    const file = {buffer: await png(400, 400), mimetype: 'image/png'};
    const logo = await uploadStoreImage(storage, 'b-1', 'logo', file);
    const cover = await uploadStoreImage(storage, 'b-1', 'cover', file);
    expect(logo.url).toMatch(
      /^https:\/\/s3\.example\.test\/KPOS\/banners\/b-1\/logo-[\w-]+\.webp$/,
    );
    expect(cover.url).toMatch(/\/banners\/b-1\/cover-[\w-]+\.webp$/);
    expect(upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({contentType: 'image/webp'}),
    );
  });

  it('says so when storage is not configured', async () => {
    const {storage} = fakeStorage(false);
    await expect(
      uploadStoreImage(storage, 'b-1', 'logo', {
        buffer: Buffer.alloc(0),
        mimetype: 'image/png',
      }),
    ).rejects.toMatchObject({code: ErrorCode.STORAGE_NOT_CONFIGURED});
  });
});

describe('isOwnStoreImage', () => {
  const {storage} = fakeStorage();
  it("accepts only this shop's uploads", () => {
    expect(
      isOwnStoreImage(storage, 'b-1', `${BASE}banners/b-1/logo-x.webp`),
    ).toBe(true);
    expect(
      isOwnStoreImage(storage, 'b-1', `${BASE}banners/b-2/logo-x.webp`),
    ).toBe(false);
    expect(isOwnStoreImage(storage, 'b-1', `${BASE}products/b-1/x.webp`)).toBe(
      false,
    );
    expect(
      isOwnStoreImage(
        storage,
        'b-1',
        'https://evil.example/banners/b-1/x.webp',
      ),
    ).toBe(false);
  });
});

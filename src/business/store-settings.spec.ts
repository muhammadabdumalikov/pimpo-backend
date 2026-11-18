import type {ModuleRef} from '@nestjs/core';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import type {DatabaseService} from '../database/database.service';
import type {Business} from '../database/schema';
import {StorageService} from '../storage/storage.service';
import {BusinessService, normalizeStoreTagline} from './business.service';

const row = {
  id: 'b-1',
  name: 'Zara Style',
  login: 'zarastyle',
  password: 'hash',
  storeSlug: 'zarastyle',
  storeEnabled: true,
} as unknown as Business;

/**
 * A drizzle stand-in for updateStoreSettings: the first await (findById)
 * yields the business, `.set()` records the patch, `.returning()` echoes it.
 */
function fakeDb() {
  const sets: Record<string, unknown>[] = [];
  let queued: unknown[] = [row];
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          const r = queued;
          queued = [];
          return (ok: (v: unknown) => unknown) => Promise.resolve(r).then(ok);
        }
        if (prop === 'set') {
          return (patch: Record<string, unknown>) => {
            sets.push(patch);
            queued = [{...row, ...patch}];
            return chain;
          };
        }
        return () => chain;
      },
    },
  );
  return {db: {db: chain} as unknown as DatabaseService, sets};
}

const BASE = 'https://s3.example.test/KPOS/';
const storage = {
  keyFromUrl: (url: string) =>
    url.startsWith(BASE) ? url.slice(BASE.length) : null,
};

function setup() {
  const {db, sets} = fakeDb();
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === StorageService) return storage;
      throw new Error('unexpected provider');
    }),
  } as unknown as ModuleRef;
  return {service: new BusinessService(db, moduleRef), sets};
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof AppException ? e.code : String(e);
  }
}

describe('updateStoreSettings — branding', () => {
  it('normalises every field it is given', async () => {
    const {service, sets} = setup();
    const updated = await service.updateStoreSettings('b-1', {
      storeTagline: "  Ayollar kiyimi\n  Toshkent bo'ylab  ",
      storeInstagram: 'https://instagram.com/ZaraStyle/?igsh=abc',
      storeTelegram: '@zara_style',
      storePhone: '90 123 45 67',
      storeLogo: `${BASE}banners/b-1/logo-1.webp`,
      storeCover: `${BASE}banners/b-1/cover-1.webp`,
    });
    expect(sets[0]).toMatchObject({
      storeTagline: "Ayollar kiyimi Toshkent bo'ylab",
      storeInstagram: 'zarastyle',
      storeTelegram: 'zara_style',
      storePhone: '+998901234567',
      storeLogo: `${BASE}banners/b-1/logo-1.webp`,
      storeCover: `${BASE}banners/b-1/cover-1.webp`,
    });
    expect(updated.storeInstagram).toBe('zarastyle');
  });

  it('leaves omitted fields out of the patch and clears on null / ""', async () => {
    const {service, sets} = setup();
    await service.updateStoreSettings('b-1', {
      storeInstagram: null,
      storeTelegram: '',
      storeLogo: '   ',
    });
    expect(sets[0]).toMatchObject({
      storeInstagram: null,
      storeTelegram: null,
      storeLogo: null,
    });
    for (const key of [
      'storeTagline',
      'storePhone',
      'storeCover',
      'storeSlug',
    ]) {
      expect(sets[0]).not.toHaveProperty(key);
    }
  });

  it.each([
    [
      {storeInstagram: 'https://instagram.com/p/C1a2b3/'},
      ErrorCode.STORE_INSTAGRAM_INVALID,
    ],
    [{storeInstagram: 'zara style'}, ErrorCode.STORE_INSTAGRAM_INVALID],
    [
      {storeTelegram: 'https://t.me/+AbCdEf123'},
      ErrorCode.STORE_TELEGRAM_INVALID,
    ],
    [{storeTelegram: 'abc'}, ErrorCode.STORE_TELEGRAM_INVALID],
    [{storePhone: '+7 701 123 45 67'}, ErrorCode.PHONE_INVALID],
    [{storeTagline: 'x'.repeat(141)}, ErrorCode.STORE_TAGLINE_TOO_LONG],
    // Someone else's picture, or any address that is not ours.
    [{storeLogo: `${BASE}banners/b-2/logo-1.webp`}, ErrorCode.VALIDATION_ERROR],
    [
      {storeCover: 'https://evil.example/cover.webp'},
      ErrorCode.VALIDATION_ERROR,
    ],
  ])('refuses %j', async (dto, code) => {
    const {service, sets} = setup();
    expect(await codeOf(service.updateStoreSettings('b-1', dto))).toBe(code);
    expect(sets).toHaveLength(0);
  });

  it('counts the tagline in characters, so 140 emoji fit', async () => {
    const {service, sets} = setup();
    await service.updateStoreSettings('b-1', {storeTagline: '🛍'.repeat(140)});
    expect(sets[0].storeTagline).toBe('🛍'.repeat(140));
  });
});

describe('normalizeStoreTagline', () => {
  it('makes one trimmed line and reads blank as null', () => {
    expect(normalizeStoreTagline(' a \n\t b ')).toBe('a b');
    expect(normalizeStoreTagline('  ')).toBeNull();
    expect(normalizeStoreTagline(null)).toBeNull();
  });
});

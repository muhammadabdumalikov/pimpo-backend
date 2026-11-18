import type {DatabaseService} from '../database/database.service';
import type {StoreSettingsService} from '../order/store-settings.service';
import {StoreService} from './store.service';

/** A drizzle stand-in: every chain call returns itself; each await yields the next queued result. */
function fakeDb(results: unknown[][]): DatabaseService {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          const r = results.shift() ?? [];
          return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve(r).then(ok, ko);
        }
        return () => chain;
      },
    },
  );
  return {db: chain} as unknown as DatabaseService;
}

const settings = {
  pickupEnabled: true,
  deliveryEnabled: false,
  deliveryFee: 15000,
  freeDeliveryFrom: null,
  minDeliveryAmount: null,
  onlineBranchId: 'br-1',
};
const storeSettings = {
  get: jest.fn().mockResolvedValue(settings),
  onlineBranch: jest
    .fn()
    .mockResolvedValue({id: 'br-1', name: 'Chilonzor', address: 'Bunyodkor 1'}),
} as unknown as StoreSettingsService;

const service = (rows: unknown[][]) =>
  new StoreService(fakeDb(rows), {} as never, storeSettings, {} as never);

describe('StoreService.getInfo — branding', () => {
  it('returns the logo, cover, tagline and contacts next to the existing fields', async () => {
    const info = await service([
      [
        {
          name: 'Zara Style',
          slug: 'zarastyle',
          logo: 'https://s3/KPOS/banners/b-1/logo-1.webp',
          cover: 'https://s3/KPOS/banners/b-1/cover-1.webp',
          tagline: 'Ayollar kiyimi',
          accent: 'rose',
          instagram: 'zarastyle',
          telegram: 'zara_style',
          phone: '+998901234567',
        },
      ],
    ]).getInfo('b-1');
    expect(info).toEqual({
      name: 'Zara Style',
      slug: 'zarastyle',
      logo: 'https://s3/KPOS/banners/b-1/logo-1.webp',
      cover: 'https://s3/KPOS/banners/b-1/cover-1.webp',
      tagline: 'Ayollar kiyimi',
      accent: 'rose',
      contacts: {
        instagram: 'zarastyle',
        telegram: 'zara_style',
        phone: '+998901234567',
      },
      fulfilment: {
        pickupEnabled: true,
        deliveryEnabled: false,
        deliveryFee: 15000,
        freeDeliveryFrom: null,
        minDeliveryAmount: null,
        pickupBranchName: 'Chilonzor',
        pickupAddress: 'Bunyodkor 1',
      },
    });
  });

  it('reads unset branding as null, never undefined', async () => {
    const info = await service([
      [
        {
          name: 'Zara Style',
          slug: 'zarastyle',
          logo: null,
          cover: null,
          tagline: null,
          instagram: null,
          telegram: null,
          phone: null,
        },
      ],
    ]).getInfo('b-1');
    expect(info).toMatchObject({
      logo: null,
      cover: null,
      tagline: null,
      contacts: {instagram: null, telegram: null, phone: null},
    });
  });

  it('gives the unscoped storefront the same shape, all branding null', async () => {
    const info = await service([]).getInfo(null);
    expect(info).toMatchObject({
      name: null,
      slug: null,
      logo: null,
      cover: null,
      tagline: null,
      contacts: {instagram: null, telegram: null, phone: null},
    });
  });
});

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

const storeSettings = {
  onlineBranch: jest.fn().mockResolvedValue({id: 'br-1', name: 'Chilonzor'}),
} as unknown as StoreSettingsService;

const service = (rows: unknown[][]) =>
  new StoreService(fakeDb(rows), {} as never, storeSettings, {} as never);

const row = (image: string | null, extraImages: string[]) => ({
  id: 'p-1',
  name: 'Nike Air Max 270',
  priceOut: '890000.00',
  image,
  categoryId: null,
  quantity: 3,
  quantityType: 'piece',
  preorder: false,
  options: null,
  leadTime: null,
  description: null,
  extraImages,
});

describe('StoreService.findOne — gallery', () => {
  it('returns the main photo first, then the extras, as `images`', async () => {
    const product = await service([
      [row('https://cdn/a.jpg', ['https://cdn/b.jpg', 'https://cdn/c.jpg'])],
    ]).findOne('b-1', 'p-1');
    expect(product.image).toBe('https://cdn/a.jpg');
    expect(product.images).toEqual([
      'https://cdn/a.jpg',
      'https://cdn/b.jpg',
      'https://cdn/c.jpg',
    ]);
  });

  it('keeps the raw extras (and every internal field) out of the public shape', async () => {
    const product = await service([[row('https://cdn/a.jpg', ['https://cdn/b.jpg'])]]).findOne(
      'b-1',
      'p-1',
    );
    expect(Object.keys(product).sort()).toEqual(
      [
        'id',
        'name',
        'priceOut',
        'image',
        'images',
        'categoryId',
        'quantity',
        'quantityType',
        'preorder',
        'options',
        'leadTime',
        'description',
      ].sort(),
    );
  });

  it('drops a main photo repeated among the extras', async () => {
    const product = await service([
      [row('https://cdn/b.jpg', ['https://cdn/a.jpg', 'https://cdn/b.jpg'])],
    ]).findOne(null, 'p-1');
    expect(product.images).toEqual(['https://cdn/b.jpg', 'https://cdn/a.jpg']);
  });

  it('gives [] for a product with no photo', async () => {
    const product = await service([[row(null, [])]]).findOne('b-1', 'p-1');
    expect(product.image).toBeNull();
    expect(product.images).toEqual([]);
  });

  it('is PRODUCT_NOT_FOUND when nothing matches', async () => {
    await expect(service([[]]).findOne('b-1', 'nope')).rejects.toMatchObject({
      code: 'PRODUCT_NOT_FOUND',
    });
  });
});

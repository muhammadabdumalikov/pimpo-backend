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

// findOne first reads the badge context (catalogue counts, then the ranked
// sales), then the product row.
const service = (rows: unknown[][]) =>
  new StoreService(
    fakeDb([[{total: 20, recent: 2}], [{productId: 'p-1', orders: 5}], ...rows]),
    {} as never,
    storeSettings,
    {} as never,
  );

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
  rawOldPrice: '990000.00',
  createdAt: new Date(),
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
        'oldPrice',
        'isNew',
        'popular',
      ].sort(),
    );
  });

  it('folds the old price and badges into the public shape', async () => {
    const product = await service([[row('https://cdn/a.jpg', [])]]).findOne('b-1', 'p-1');
    expect(product.oldPrice).toBe('990000.00');
    expect(product.isNew).toBe(true);
    expect(product.popular).toBe(true);
  });

  it('drops a main photo repeated among the extras', async () => {
    // Unscoped: no badge reads, straight to the row.
    const product = await new StoreService(
      fakeDb([[row('https://cdn/b.jpg', ['https://cdn/a.jpg', 'https://cdn/b.jpg'])]]),
      {} as never,
      storeSettings,
      {} as never,
    ).findOne(null, 'p-1');
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

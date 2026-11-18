import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
import {CreateProductDto} from './create-product.dto';
import {UpdateProductDto} from './update-product.dto';

const url = (n: number) => `https://cdn.example/p/${n}.jpg`;
const base = {name: 'Nike Air Max 270', priceIn: '500000', priceOut: '890000', quantity: 1};

/** The failing property names, as the global ValidationPipe would see them. */
async function failing(cls: typeof CreateProductDto | typeof UpdateProductDto, body: object) {
  const errors = await validate(plainToInstance(cls, body), {whitelist: true});
  return errors.map((e) => e.property);
}

describe.each([
  ['CreateProductDto', CreateProductDto, base],
  ['UpdateProductDto', UpdateProductDto, {}],
] as const)('%s.extraImages', (_name, cls, body) => {
  it('is optional', async () => {
    expect(await failing(cls, body)).toEqual([]);
  });

  it('accepts up to 7 photos, and [] to clear', async () => {
    const seven = Array.from({length: 7}, (_, i) => url(i));
    expect(await failing(cls, {...body, extraImages: seven})).toEqual([]);
    expect(await failing(cls, {...body, extraImages: []})).toEqual([]);
  });

  it('rejects an 8th photo', async () => {
    const eight = Array.from({length: 8}, (_, i) => url(i));
    expect(await failing(cls, {...body, extraImages: eight})).toEqual(['extraImages']);
  });

  it('rejects non-strings, a non-array and URLs longer than products.image holds', async () => {
    expect(await failing(cls, {...body, extraImages: [url(1), 5]})).toEqual(['extraImages']);
    expect(await failing(cls, {...body, extraImages: url(1)})).toEqual(['extraImages']);
    expect(
      await failing(cls, {...body, extraImages: [`https://x/${'a'.repeat(500)}`]}),
    ).toEqual(['extraImages']);
  });
});

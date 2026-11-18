import {
  MAX_EXTRA_PRODUCT_IMAGES,
  cleanExtraImages,
  productGallery,
} from './product-images';

const url = (n: number) => `https://cdn.example/p/${n}.jpg`;

describe('cleanExtraImages', () => {
  it('keeps the photos in the order given', () => {
    expect(cleanExtraImages([url(3), url(1), url(2)], url(0))).toEqual([
      url(3),
      url(1),
      url(2),
    ]);
  });

  it('trims, and drops blanks and repeats', () => {
    expect(
      cleanExtraImages([` ${url(1)} `, '', '   ', url(1), url(2), url(2)], null),
    ).toEqual([url(1), url(2)]);
  });

  it('drops any copy of the main photo', () => {
    expect(cleanExtraImages([url(1), url(0), ` ${url(0)}`], url(0))).toEqual([
      url(1),
    ]);
    expect(cleanExtraImages([url(1)], ` ${url(1)} `)).toEqual([]);
  });

  it(`keeps at most ${MAX_EXTRA_PRODUCT_IMAGES}, counted after cleaning`, () => {
    const many = Array.from({length: 10}, (_, i) => url(i + 1));
    expect(cleanExtraImages(many, null)).toEqual(many.slice(0, MAX_EXTRA_PRODUCT_IMAGES));
    // Dropped entries do not use up a slot.
    expect(cleanExtraImages([url(0), url(1), url(1), ...many.slice(1)], url(0))).toEqual(
      many.slice(0, MAX_EXTRA_PRODUCT_IMAGES),
    );
  });

  it('ignores non-strings and treats a missing list as none', () => {
    expect(cleanExtraImages([url(1), null, 5, {}] as unknown[], null)).toEqual([url(1)]);
    expect(cleanExtraImages(undefined, url(0))).toEqual([]);
    expect(cleanExtraImages(null, url(0))).toEqual([]);
  });
});

describe('productGallery', () => {
  it('puts the main photo first, then the extras', () => {
    expect(productGallery(url(0), [url(1), url(2)])).toEqual([url(0), url(1), url(2)]);
  });

  it('is just the main photo when there are no extras', () => {
    expect(productGallery(url(0), [])).toEqual([url(0)]);
    expect(productGallery(url(0), null)).toEqual([url(0)]);
  });

  it('still shows the extras when the main photo is missing or blank', () => {
    expect(productGallery(null, [url(1), url(2)])).toEqual([url(1), url(2)]);
    expect(productGallery('  ', [url(1)])).toEqual([url(1)]);
  });

  it('drops repeats — e.g. an old client set the main photo to one of the extras', () => {
    expect(productGallery(url(2), [url(1), url(2), url(1)])).toEqual([url(2), url(1)]);
  });

  it('is empty for a card with no photo', () => {
    expect(productGallery(null, [])).toEqual([]);
    expect(productGallery('', ['', '  '])).toEqual([]);
  });
});

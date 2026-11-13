import {THUMB_SUFFIX, makeThumbWebp, thumbKey} from './thumbnail';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const sharp: typeof import('sharp').default = require('sharp');

describe('thumbnail', () => {
  it('names the small copy next to the original', () => {
    expect(thumbKey('products/ai/b/x.webp')).toBe(
      'products/ai/b/x.webp.t320.webp',
    );
    expect(THUMB_SUFFIX).toBe('.t320.webp');
  });

  it('makes a 320px white-backed WebP', async () => {
    const src = await sharp({
      create: {
        width: 800,
        height: 400,
        channels: 4,
        background: {r: 255, g: 0, b: 0, alpha: 0},
      },
    })
      .png()
      .toBuffer();
    const out = await makeThumbWebp(src);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(320);
    expect(meta.hasAlpha).toBe(false);
  });

  it('pads a small source onto the 320 canvas instead of stretching it', async () => {
    const src = await sharp({
      create: {width: 100, height: 100, channels: 3, background: '#0f0'},
    })
      .png()
      .toBuffer();
    const meta = await sharp(await makeThumbWebp(src)).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(320);
  });
});

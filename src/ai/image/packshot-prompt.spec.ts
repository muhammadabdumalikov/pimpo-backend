import {
  DESCRIBE_SYSTEM_PROMPT,
  MAX_DESCRIPTION_LENGTH,
  cleanDescription,
  describeInstruction,
  photoPackshotPrompt,
  textPackshotPrompt,
} from './packshot-prompt';

describe('packshot prompts', () => {
  const desc =
    'Coca-Cola classic 330ml aluminum can, featuring the standard red branding';

  it('keeps the owner wording and drops the image_42/43 references (Q5)', () => {
    for (const prompt of [
      textPackshotPrompt(desc),
      photoPackshotPrompt(desc),
    ]) {
      expect(prompt).not.toMatch(/image_4\d/);
      expect(prompt).toContain('spotless, pure white background');
      expect(prompt).toContain('facing straight forward');
      expect(prompt).toContain(desc);
    }
  });

  it('text mode opens with the universal packshot sentence', () => {
    expect(textPackshotPrompt(desc)).toMatch(
      /^A high-resolution, professional studio product photograph of Coca-Cola/,
    );
  });

  it('photo mode forbids inventing or translating label text', () => {
    const prompt = photoPackshotPrompt(desc);
    expect(prompt).toContain('attached photo');
    expect(prompt).toMatch(/letter for letter/);
    expect(prompt).toMatch(/Do not invent, translate, add or remove any text/);
  });

  it('lists the photo in the describe instruction when there is one', () => {
    expect(
      describeInstruction({name: ' МариМолоко 350гр п/б ', hasPhoto: true}),
    ).toBe(
      'Product name: МариМолоко 350гр п/б\nA photo of the product is attached.',
    );
    expect(
      describeInstruction({
        name: 'Snickers',
        brand: 'Mars',
        category: 'Shokolad',
        unit: 'Dona',
        hasPhoto: false,
      }),
    ).toBe(
      'Product name: Snickers\nBrand: Mars\nCategory: Shokolad\nSold by: Dona\nThere is no photo.',
    );
  });
});

describe('describe step rules', () => {
  // "Готовый завтрак UNICORN … 10*160 г" came back as "10 packs of 160g
  // each" before these rules — the image model then draws a case.
  it('drops supplier case counts and promo words', () => {
    expect(DESCRIBE_SYSTEM_PROMPT).toContain('10*160');
    expect(DESCRIBE_SYSTEM_PROMPT).toMatch(/never say how\s+many units/);
    expect(DESCRIBE_SYSTEM_PROMPT).toMatch(/акция.*aksiya/s);
  });

  // Search confirmed МариМолоко 350гр п/б is a plastic BOTTLE of condensed
  // milk; the old rule guessed "pouch" for anything milky.
  it('reads п/б as a plastic bottle', () => {
    expect(DESCRIBE_SYSTEM_PROMPT).toMatch(/п\/б or пл\/б = plastic\s+bottle/);
  });
});

describe('cleanDescription', () => {
  it('flattens lines, strips quotes and the trailing full stop', () => {
    expect(cleanDescription('"Milka bar,\n purple wrapper, 100g."\n')).toBe(
      'Milka bar, purple wrapper, 100g',
    );
    expect(cleanDescription('«Сок Rich 1л»')).toBe('Сок Rich 1л');
  });

  it('caps the length', () => {
    expect(cleanDescription('x'.repeat(2000))).toHaveLength(
      MAX_DESCRIPTION_LENGTH,
    );
  });

  it('returns empty for blank input', () => {
    expect(cleanDescription('  \n  ')).toBe('');
  });
});

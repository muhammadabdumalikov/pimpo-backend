import {latinToCyrillic, escapeRegex} from './uz-translit';

describe('latinToCyrillic', () => {
  it('transliterates plain Latin Uzbek', () => {
    expect(latinToCyrillic('non')).toBe('нон');
    expect(latinToCyrillic('sut')).toBe('сут');
  });

  it('handles digraphs before single letters', () => {
    expect(latinToCyrillic('shokolad')).toBe('шоколад');
    expect(latinToCyrillic('choy')).toBe('чой');
  });

  it("maps the apostrophe letters o' and g'", () => {
    expect(latinToCyrillic("go'sht")).toBe('гўшт');
    expect(latinToCyrillic("yog'")).toBe('ёғ');
  });

  it('accepts the typographic apostrophe too', () => {
    expect(latinToCyrillic('goʻsht')).toBe('гўшт');
  });

  it('is case-insensitive', () => {
    expect(latinToCyrillic('NON')).toBe('нон');
  });

  it('passes unmapped characters through', () => {
    expect(latinToCyrillic('pepsi 1 l')).toBe('пепси 1 л');
  });

  it('returns null when the input is already Cyrillic', () => {
    expect(latinToCyrillic('нон')).toBeNull();
  });

  it('returns null when nothing would change', () => {
    expect(latinToCyrillic('4780137640145')).toBeNull();
    expect(latinToCyrillic('   ')).toBeNull();
  });
});

describe('escapeRegex', () => {
  it('escapes POSIX regex metacharacters', () => {
    expect(escapeRegex('1.5 l')).toBe('1\\.5 l');
    expect(escapeRegex('sok (mix)')).toBe('sok \\(mix\\)');
    expect(escapeRegex('a+b*c?')).toBe('a\\+b\\*c\\?');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeRegex('pepsi')).toBe('pepsi');
  });
});

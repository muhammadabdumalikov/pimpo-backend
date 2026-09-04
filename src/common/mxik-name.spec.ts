import {mxikDisplayName, mxikClassName} from './mxik-name';

describe('mxikDisplayName', () => {
  it('drops the classifier class prefix, keeping brand + attributes', () => {
    expect(mxikDisplayName('Бошқа нон турлари: Flint, кабоб таъмли 60 г')).toBe(
      'Flint, кабоб таъмли 60 г',
    );
  });

  it('splits on the first ": " only, so attributes keep their own colons', () => {
    expect(mxikDisplayName('Соус: Heinz, ўткир: экстра 250 г')).toBe(
      'Heinz, ўткир: экстра 250 г',
    );
  });

  it('leaves a name without a class prefix untouched', () => {
    expect(mxikDisplayName('Товуқ гўшти')).toBe('Товуқ гўшти');
  });

  it('keeps the full name when the suffix is too short to stand alone', () => {
    expect(mxikDisplayName('Ароқ: 1')).toBe('Ароқ: 1');
  });

  it('strips a Latin category prefix off a community-catalog name', () => {
    // global_barcodes rows come from real shop catalogs; imports bake the
    // category into the name the same way the classifier does.
    expect(mxikDisplayName('Alkogolsiz ichimliklar: Chernogolovka')).toBe(
      'Chernogolovka',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(mxikDisplayName('  Вино: Chateau, қизил 0,75 л  ')).toBe(
      'Chateau, қизил 0,75 л',
    );
  });
});

describe('mxikClassName', () => {
  it('returns the class prefix', () => {
    expect(mxikClassName('Бошқа нон турлари: Flint, кабоб таъмли 60 г')).toBe(
      'Бошқа нон турлари',
    );
  });

  it('returns null when there is no prefix', () => {
    expect(mxikClassName('Товуқ гўшти')).toBeNull();
  });

  it('returns null when the suffix is too short (nothing was stripped)', () => {
    expect(mxikClassName('Ароқ: 1')).toBeNull();
  });
});

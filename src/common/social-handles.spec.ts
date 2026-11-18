import {normalizeInstagram, normalizeTelegram} from './social-handles';

describe('normalizeInstagram', () => {
  it.each([
    ['zarastyle', 'zarastyle'],
    ['@zarastyle', 'zarastyle'],
    ['  @ZaraStyle  ', 'zarastyle'],
    ['zara.style_uz', 'zara.style_uz'],
    ['https://instagram.com/zarastyle/', 'zarastyle'],
    ['https://www.instagram.com/zarastyle', 'zarastyle'],
    ['instagram.com/zarastyle?igsh=MWx4dTZ5c2Q3bWZ3Yg==', 'zarastyle'],
    ['www.instagram.com/zarastyle/?hl=ru', 'zarastyle'],
    ['http://m.instagram.com/zarastyle', 'zarastyle'],
    ['https://instagram.com/@zarastyle', 'zarastyle'],
    ['https://www.instagram.com/stories/zarastyle/3301234567/', 'zarastyle'],
    ['instagr.am/zarastyle', 'zarastyle'],
  ])('reads %s as %s', (raw, expected) => {
    expect(normalizeInstagram(raw)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    [null],
    [undefined],
    ['@'],
    ['zara style'], // space
    ['.zarastyle'], // leading period
    ['zarastyle.'], // trailing period
    ['zara..style'], // two periods in a row
    ['zara-style'], // hyphen
    ['a'.repeat(31)], // too long
    ['instagram.com'], // the site, not an account
    ['https://instagram.com/'],
    ['https://www.instagram.com/p/C1a2b3c4d5/'], // a post
    ['https://www.instagram.com/reel/C1a2b3c4d5/'],
    ['https://facebook.com/zarastyle'], // another site
    ['https://t.me/zarastyle'],
  ])('rejects %s', (raw) => {
    expect(normalizeInstagram(raw)).toBeNull();
  });
});

describe('normalizeTelegram', () => {
  it.each([
    ['zarastyle', 'zarastyle'],
    ['@ZaraStyle', 'ZaraStyle'], // case kept
    ['  @zara_style  ', 'zara_style'],
    ['t.me/zarastyle', 'zarastyle'],
    ['https://t.me/zarastyle', 'zarastyle'],
    ['https://t.me/zarastyle/', 'zarastyle'],
    ['https://t.me/zarastyle?start=hello', 'zarastyle'],
    ['https://telegram.me/zarastyle', 'zarastyle'],
    ['https://t.me/s/zarastyle', 'zarastyle'], // channel web preview
    ['https://t.me/zarastyle/123', 'zarastyle'], // a post in the channel
  ])('reads %s as %s', (raw, expected) => {
    expect(normalizeTelegram(raw)).toBe(expected);
  });

  it.each([
    [''],
    [null],
    [undefined],
    ['@'],
    ['zara'], // too short (5 minimum)
    ['1zarastyle'], // must start with a letter
    ['zarastyle_'], // may not end with an underscore
    ['zara.style'], // no periods
    ['a'.repeat(33)], // too long
    ['t.me'],
    ['https://t.me/+AbCdEfGh12345'], // private invite
    ['https://t.me/joinchat/AbCdEfGh12345'],
    ['https://t.me/addstickers/somepack'],
    ['https://instagram.com/zarastyle'], // another site
  ])('rejects %s', (raw) => {
    expect(normalizeTelegram(raw)).toBeNull();
  });
});

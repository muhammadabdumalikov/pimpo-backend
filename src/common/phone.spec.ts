import {normalizeUzPhone, PHONE_INPUT_RE} from './phone';

describe('normalizeUzPhone', () => {
  it.each([
    ['+998 90 123 45 67', '+998901234567'],
    ['998901234567', '+998901234567'],
    ['+998(90)123-45-67', '+998901234567'],
    ['90 123 45 67', '+998901234567'],
    ['8 90 123 45 67', '+998901234567'],
  ])('reads %s as %s', (raw, expected) => {
    expect(normalizeUzPhone(raw)).toBe(expected);
  });

  it.each([
    [''],
    [null],
    [undefined],
    ['+998 90 123 45'], // too short
    ['+998 90 123 45 678'], // too long
    ['+7 701 123 45 67'], // not Uzbek
    ['123456789012'], // 12 digits, wrong country code
  ])('rejects %s', (raw) => {
    expect(normalizeUzPhone(raw)).toBeNull();
  });
});

describe('PHONE_INPUT_RE', () => {
  it('accepts digits with separators and refuses text', () => {
    expect(PHONE_INPUT_RE.test('+998 (90) 123-45-67')).toBe(true);
    expect(PHONE_INPUT_RE.test('call me')).toBe(false);
    expect(PHONE_INPUT_RE.test('12345')).toBe(false);
  });
});

import {isOpenAt, normalizeWorkingHours} from '../branch/working-hours';
import {detectLocale} from './assistant-text';
import {fold, hoursText, queryVariants} from './assistant-tools';

// 2026-11-09 is a Monday. Tashkent = UTC+5.
const at = (isoLocal: string) => new Date(`${isoLocal}+05:00`);

describe('working hours', () => {
  const week = normalizeWorkingHours({
    mon: {open: '09:00', close: '21:00'},
    fri: {open: '09:00', close: '21:00'},
    sat: {open: '22:00', close: '03:00'}, // past midnight
    sun: null,
  });

  it('is open inside the day window, closed outside', () => {
    expect(isOpenAt(week, at('2026-11-09T10:00:00'))).toBe(true);
    expect(isOpenAt(week, at('2026-11-09T21:00:00'))).toBe(false);
    expect(isOpenAt(week, at('2026-11-09T08:59:00'))).toBe(false);
  });

  it('treats a missing day as closed and null hours as unknown', () => {
    expect(isOpenAt(week, at('2026-11-10T12:00:00'))).toBe(false); // tue absent
    expect(isOpenAt(null, at('2026-11-10T12:00:00'))).toBeNull();
  });

  it('runs a close-before-open day past midnight', () => {
    expect(isOpenAt(week, at('2026-11-14T23:30:00'))).toBe(true); // sat night
    expect(isOpenAt(week, at('2026-11-15T02:00:00'))).toBe(true); // sun 02:00
    expect(isOpenAt(week, at('2026-11-15T04:00:00'))).toBe(false);
  });

  it('rejects typos and bad times', () => {
    expect(() => normalizeWorkingHours({thur: null})).toThrow();
    expect(() => normalizeWorkingHours({mon: {open: '9:00', close: '21:00'}})).toThrow();
    expect(() => normalizeWorkingHours({mon: {open: '10:00', close: '10:00'}})).toThrow();
    expect(normalizeWorkingHours(null)).toBeNull();
  });

  it('writes the week out for the model', () => {
    expect(
      hoursText({
        mon: {open: '09:00', close: '21:00'},
        tue: {open: '09:00', close: '21:00'},
        wed: {open: '09:00', close: '21:00'},
        thu: {open: '09:00', close: '21:00'},
        fri: {open: '09:00', close: '21:00'},
        sat: {open: '10:00', close: '20:00'},
        sun: null,
      }),
    ).toBe('Dushanba–Juma 09:00–21:00; Shanba 10:00–20:00; Yakshanba: dam olish');
  });
});

describe('detectLocale', () => {
  it.each([
    ['ayfon bormi', 'uz'],
    ['Сникерс борми?', 'uzc'],
    ['Етказиб бериш борми?', 'uzc'],
    ['Мумкинми картадан', 'uzc'],
    ['Қанча туради', 'uzc'],
    ['Сколько стоит кока кола?', 'ru'],
    ['Когда будет доставка?', 'ru'],
    ['С детьми можно?', 'ru'],
  ])('%s → %s', (text, locale) => {
    expect(detectLocale(text)).toBe(locale);
  });
});

describe('product search variants', () => {
  it('adds the other script and the apostrophe-less form', () => {
    expect(queryVariants('айфон')).toEqual(expect.arrayContaining(['айфон', 'ayfon']));
    expect(queryVariants("o'rik")).toEqual(expect.arrayContaining(["o'rik", 'ўрик', 'orik']));
  });

  it('folds c→k and hyphens on the query side', () => {
    expect(fold('coca-cola')).toBe('koka kola');
  });
});

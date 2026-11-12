import {digestWindow, dueSlot, latestOccurrence, localParts} from './digest-schedule';

// Business-zone wall clock → instant.
const at = (s: string) => new Date(`${s}:00.000+05:00`);
const fmt = (d: Date) => {
  const p = localParts(d);
  return `${p.ymd} ${p.hm}`;
};

describe('digest schedule', () => {
  it('latest occurrence is today when passed, yesterday when not', () => {
    expect(fmt(latestOccurrence(at('2026-11-13T21:30'), '21:00'))).toBe('2026-11-13 21:00');
    expect(fmt(latestOccurrence(at('2026-11-13T21:00'), '21:00'))).toBe('2026-11-13 21:00');
    expect(fmt(latestOccurrence(at('2026-11-13T20:59'), '21:00'))).toBe('2026-11-12 21:00');
    // 03:00 local is still the previous UTC day.
    expect(fmt(latestOccurrence(at('2026-11-13T03:10'), '00:00'))).toBe('2026-11-13 00:00');
  });

  it('defaults reproduce the old 21:00 day-so-far digest', () => {
    const w = digestWindow(at('2026-11-13T21:00'), '00:00', '21:00');
    expect(fmt(w.start)).toBe('2026-11-13 00:00');
    expect(fmt(w.end)).toBe('2026-11-13 21:00');
  });

  it('a window across midnight ends today and starts yesterday', () => {
    const w = digestWindow(at('2026-11-13T03:30'), '22:00', '03:00');
    expect(fmt(w.start)).toBe('2026-11-12 22:00');
    expect(fmt(w.end)).toBe('2026-11-13 03:00');
  });

  it('from = to is a full 24 hours', () => {
    const w = digestWindow(at('2026-11-13T09:00'), '00:00', '00:00');
    expect(fmt(w.start)).toBe('2026-11-12 00:00');
    expect(fmt(w.end)).toBe('2026-11-13 00:00');
  });

  it('a send time inside the window reports that window so far', () => {
    const w = digestWindow(at('2026-11-13T21:00'), '09:00', '23:00');
    expect(fmt(w.start)).toBe('2026-11-13 09:00');
    expect(fmt(w.end)).toBe('2026-11-13 21:00');
  });

  it('a send time before the window opens reports the last closed one', () => {
    const w = digestWindow(at('2026-11-13T08:00'), '09:00', '21:00');
    expect(fmt(w.start)).toBe('2026-11-12 09:00');
    expect(fmt(w.end)).toBe('2026-11-12 21:00');
  });

  it('full 24 h sent at noon is the last full day, not a partial one', () => {
    const w = digestWindow(at('2026-11-13T12:00'), '00:00', '00:00');
    expect(fmt(w.start)).toBe('2026-11-12 00:00');
    expect(fmt(w.end)).toBe('2026-11-13 00:00');
  });

  it('due once per slot, caught up within two hours', () => {
    const now = at('2026-11-13T21:01');
    expect(fmt(dueSlot(now, '21:00', null)!)).toBe('2026-11-13 21:00');
    expect(dueSlot(now, '21:00', at('2026-11-13T21:00'))).toBeNull();
    expect(fmt(dueSlot(now, '21:00', at('2026-11-12T21:00'))!)).toBe('2026-11-13 21:00');
    expect(dueSlot(at('2026-11-13T23:01'), '21:00', null)).toBeNull();
    expect(dueSlot(at('2026-11-13T20:59'), '21:00', null)).toBeNull();
  });
});

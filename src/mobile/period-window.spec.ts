import {periodWindow} from './mobile.service';

// Business zone is +05:00: 2026-10-05T09:30:00Z is Monday 14:30 in Tashkent.
const NOW = new Date('2026-10-05T09:30:00.000Z');

describe('periodWindow', () => {
  it('compares today so far with the same weekday last week, same time', () => {
    const w = periodWindow('today', NOW);
    expect(w.from).toBe('2026-10-05');
    expect(w.to).toBe('2026-10-05');
    expect(w.start.toISOString()).toBe('2026-10-04T19:00:00.000Z');
    expect(w.prevStart.toISOString()).toBe('2026-09-27T19:00:00.000Z');
    expect(w.prevEnd.toISOString()).toBe('2026-09-28T09:30:00.000Z');
  });

  it('starts the week on Monday and compares the same stretch of last week', () => {
    const thursday = new Date('2026-10-08T06:00:00.000Z'); // Thu 11:00
    const w = periodWindow('week', thursday);
    expect(w.from).toBe('2026-10-05');
    expect(w.prevStart.toISOString()).toBe('2026-09-27T19:00:00.000Z');
    expect(w.prevEnd.getTime() - w.prevStart.getTime()).toBe(
      thursday.getTime() - w.start.getTime(),
    );
  });

  it('treats Sunday as the last day of the week', () => {
    const sunday = new Date('2026-10-11T10:00:00.000Z');
    expect(periodWindow('week', sunday).from).toBe('2026-10-05');
  });

  it('compares the month so far with the start of last month', () => {
    const w = periodWindow('month', NOW);
    expect(w.from).toBe('2026-10-01');
    expect(w.prevStart.toISOString()).toBe('2026-08-31T19:00:00.000Z');
  });

  it('never lets a short previous month run into the current one', () => {
    const march31 = new Date('2026-03-31T15:00:00.000Z');
    const w = periodWindow('month', march31);
    expect(w.prevStart.toISOString()).toBe('2026-01-31T19:00:00.000Z');
    expect(w.prevEnd.getTime()).toBeLessThanOrEqual(w.start.getTime());
  });

  it('crosses the year boundary for January', () => {
    const w = periodWindow('month', new Date('2026-01-10T10:00:00.000Z'));
    expect(w.prevStart.toISOString()).toBe('2025-11-30T19:00:00.000Z');
  });
});

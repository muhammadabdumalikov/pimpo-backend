import {pickLocalized, renderPush} from './push-text';

describe('renderPush', () => {
  it('writes a shift shortage in Uzbek and Russian', () => {
    const notice = {
      event: 'shiftClosed' as const,
      data: {registerName: 'Kassa-2', diff: -45000, cashierName: 'Aziz', url: '/money'},
    };
    expect(renderPush(notice, 'uz')).toEqual({
      title: '🔴 Smena yopildi — Kassa-2',
      body: "⚠️ Kamomad 45 000 so'm · Aziz",
    });
    expect(renderPush(notice, 'ru').body).toBe('⚠️ Недостача 45 000 сум · Aziz');
  });

  it('falls back to Uzbek for other locales', () => {
    const notice = {event: 'onlineOrder' as const, data: {total: 120000, url: '/sales'}};
    expect(renderPush(notice, 'uzc').title).toBe("🛒 Yangi onlayn buyurtma — 120 000 so'm");
  });

  it('drops empty parts instead of leaving dangling separators', () => {
    const notice = {event: 'checkout' as const, data: {total: 5000, url: '/sales'}};
    expect(renderPush(notice, 'uz').body).toBe('');
  });
});

describe('pickLocalized', () => {
  it('prefers the requested language, then Uzbek', () => {
    expect(pickLocalized({uz: 'Salom', ru: 'Привет'}, 'ru')).toBe('Привет');
    expect(pickLocalized({uz: 'Salom'}, 'ru')).toBe('Salom');
  });
});

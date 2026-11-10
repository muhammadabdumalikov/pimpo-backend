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

describe('renderPush billing', () => {
  it('reads "continue" during the trial and "you owe" otherwise', () => {
    const trial = {event: 'billing' as const, data: {kind: 'd3', isTrial: true, daysLeft: 1, url: '/x'}};
    expect(renderPush(trial, 'uz').title).toBe('⏳ Bepul sinov davri ertaga tugaydi');
    const paid = {
      event: 'billing' as const,
      data: {kind: 'd7', isTrial: false, daysLeft: 6, amountDue: 299000, url: '/x'},
    };
    expect(renderPush(paid, 'uz')).toEqual({
      title: '⏳ Obuna 6 kundan keyin tugaydi',
      body: "Keyingi oy uchun 299 000 so'm yetishmayapti",
    });
    expect(renderPush(paid, 'ru').title).toBe('⏳ Подписка закончится через 6 дн.');
  });

  it('says when a renewal leaves next month short', () => {
    const notice = {
      event: 'billing' as const,
      data: {kind: 'renewed', periodEnd: '10.12.2026', charged: 299000, shortfall: 50000, url: '/x'},
    };
    expect(renderPush(notice, 'uz')).toEqual({
      title: '✅ Obuna yangilandi — 10.12.2026 gacha',
      body: "299 000 so'm yechildi · keyingi oyga yana 50 000 so'm kerak",
    });
  });
});

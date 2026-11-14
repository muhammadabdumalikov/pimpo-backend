import {
  billingNoticeText,
  billingRenewedText,
  tashkentDate,
} from './billing-text';

describe('tashkentDate', () => {
  it('formats the Tashkent calendar day', () => {
    // 20:00Z on the 9th is already the 10th in Tashkent.
    expect(tashkentDate('2026-12-09T20:00:00Z')).toBe('10.12.2026');
  });
});

describe('billingNoticeText', () => {
  const base = {
    isTrial: false,
    daysLeft: 3,
    endDate: '2026-11-13T07:00:00Z',
    amountDue: 299000,
    planName: 'Biznes',
  };

  it('tells a paying shop how much is missing', () => {
    expect(billingNoticeText({...base, kind: 'd3'})).toBe(
      [
        '⚠️ Obuna (Biznes) 3 kundan keyin tugaydi (13.11.2026).',
        "Keyingi oy uchun balansda 299 000 so'm yetishmayapti.",
        "“Obuna boshqaruvi” bo'limida “To'lash” tugmasini bosing.",
      ].join('\n'),
    );
  });

  it('asks a trial shop to continue, not to pay a debt', () => {
    const text = billingNoticeText({
      ...base,
      kind: 'd7',
      isTrial: true,
      daysLeft: 0,
    });
    expect(text).toContain('Bepul sinov davri bugun tugaydi');
    expect(text).not.toContain('yetishmayapti');
  });

  it('keeps the till working once restricted', () => {
    expect(billingNoticeText({...base, kind: 'restricted'})).toContain(
      'Kassa ishlashda davom etadi',
    );
  });
});

describe('billingRenewedText', () => {
  it('warns ahead when next month is not covered', () => {
    expect(
      billingRenewedText({
        planName: 'Biznes',
        periodEnd: '2026-12-10T07:00:00Z',
        charged: 299000,
        balanceAfter: 1000,
        nextShortfall: 298000,
      }),
    ).toBe(
      [
        '✅ Obuna yangilandi: Biznes, 10.12.2026 gacha.',
        "Balansdan 299 000 so'm yechildi. Qoldiq: 1 000 so'm.",
        "Keyingi to'lov uchun balansda yana 298 000 so'm kerak bo'ladi.",
      ].join('\n'),
    );
  });
});

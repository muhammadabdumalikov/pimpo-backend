import {
  NOTICE_KIND,
  billingNoticeButton,
  billingNoticeText,
  billingRenewedText,
  reminderVerdict,
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

  it('tells a paying shop when it ends, how much is missing and where to pay', () => {
    expect(billingNoticeText({...base, kind: 'd3'})).toBe(
      [
        "⚠️ Assalomu alaykum! KPOS'dagi “Biznes” obunangiz 3 kundan keyin, 13-noyabrda tugaydi.",
        "Uzaytirish uchun balansda yana 299 000 so'm kerak. Balans to'ldirilsa, obuna o'z vaqtida avtomatik uzayadi.",
        "To'lash uchun pastdagi tugmani bosing yoki ilovada “Obuna boshqaruvi” bo'limiga kiring.",
        "To'lanmasa, tugaganidan 3 kun o'tib KPOS to'liq yopiladi, kassa ham.",
      ].join('\n'),
    );
  });

  it('puts a button under the notice that opens the subscription page', () => {
    expect(billingNoticeButton({isTrial: false, base: 'https://kpos.uz'})).toEqual({
      text: "💳 To'lash",
      url: 'https://kpos.uz/subscription-management',
    });
    expect(billingNoticeButton({isTrial: true, base: 'https://kpos.uz'}).text).toBe(
      '✅ Tarifni tanlash',
    );
  });

  it('reads the address from APP_URL, without a trailing slash', () => {
    const before = process.env.APP_URL;
    process.env.APP_URL = 'https://app.example.uz/ ';
    try {
      expect(billingNoticeButton({isTrial: false}).url).toBe(
        'https://app.example.uz/subscription-management',
      );
    } finally {
      if (before === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = before;
    }
  });

  it('never says "next month": a yearly shop renews for a year', () => {
    for (const kind of ['d7', 'd3', 'expired', 'restricted'] as const) {
      expect(billingNoticeText({...base, kind})).not.toContain('oy uchun');
    }
  });

  it('says today and tomorrow in words', () => {
    expect(billingNoticeText({...base, kind: 'd3', daysLeft: 0})).toContain(
      'obunangiz bugun, 13-noyabrda tugaydi',
    );
    expect(billingNoticeText({...base, kind: 'd3', daysLeft: 1})).toContain(
      'obunangiz ertaga, 13-noyabrda tugaydi',
    );
  });

  it('asks a trial shop to continue, not to pay a debt', () => {
    const text = billingNoticeText({
      ...base,
      kind: 'd7',
      isTrial: true,
      daysLeft: 0,
    });
    expect(text).toContain('bepul sinov davringiz bugun, 13-noyabrda tugaydi');
    expect(text).toContain('“Davom ettirish”');
    expect(text).toContain('pastdagi tugmani bosib');
    expect(text).not.toContain("so'm");
  });

  it('counts the days left before KPOS closes, not always three', () => {
    expect(billingNoticeText({...base, kind: 'expired'})).toContain(
      "3 kundan keyin KPOS to'liq yopiladi",
    );
    expect(
      billingNoticeText({...base, kind: 'expired', graceDaysLeft: 1}),
    ).toContain("ertaga KPOS to'liq yopiladi");
    expect(
      billingNoticeText({...base, kind: 'expired', isTrial: true, graceDaysLeft: 0}),
    ).toContain("bugun KPOS to'liq yopiladi");
  });

  it('says plainly that the till closes too, and the data stays', () => {
    for (const isTrial of [false, true]) {
      expect(billingNoticeText({...base, kind: 'expired', isTrial})).toContain('kassa ham');
      const closed = billingNoticeText({...base, kind: 'restricted', isTrial});
      expect(closed).toContain('KPOS yopildi: kassa ham');
      expect(closed).toContain("Ma'lumotlaringiz saqlanib turibdi");
      expect(closed).not.toContain('Kassa ishlashda davom etadi');
    }
  });

  it('warns of the closing only in the last reminder', () => {
    expect(billingNoticeText({...base, kind: 'd7'})).not.toContain('yopiladi');
    expect(billingNoticeText({...base, kind: 'd3', isTrial: true})).toContain(
      "KPOS to'liq yopiladi, kassa ham",
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

describe('reminderVerdict', () => {
  const ok = {
    stage: 'urgent' as const,
    endDate: new Date('2026-11-20T07:00:00Z'),
    botReady: true,
    chats: 1,
  };

  it('allows a reminder for every stage the daily run writes a notice for', () => {
    for (const stage of ['reminder', 'urgent', 'grace', 'restricted'] as const) {
      expect(NOTICE_KIND[stage]).toBeDefined();
      expect(reminderVerdict({...ok, stage})).toBe('ok');
    }
  });

  it('has nothing to remind a paid-up or open-ended shop of', () => {
    expect(reminderVerdict({...ok, stage: 'none'})).toBe('not_due');
    expect(reminderVerdict({...ok, endDate: null})).toBe('not_due');
  });

  it('needs the bot and at least one linked chat', () => {
    expect(reminderVerdict({...ok, botReady: false})).toBe('no_bot');
    expect(reminderVerdict({...ok, chats: 0})).toBe('no_chats');
  });

  it('says "not due" first: a shop with no chat and nothing due is not a Telegram problem', () => {
    expect(reminderVerdict({...ok, stage: 'none', chats: 0, botReady: false})).toBe('not_due');
  });
});

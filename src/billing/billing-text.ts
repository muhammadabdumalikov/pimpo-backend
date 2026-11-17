// Telegram texts of the subscription billing notices (OBUNA-TOLOV.md Q8, Q15,
// Q16). Uzbek, like every other message the shop bot sends; phone push gets
// its own uz/ru lines from notification/push-text.ts (event 'billing').

import {BUSINESS_OFFSET_MS} from '../common/business-time';
import {GRACE_DAYS, type BillingStage} from './billing';

export type BillingNoticeKind = 'd7' | 'd3' | 'expired' | 'restricted';

/** The notice each billing stage calls for; none while the plan is paid up. */
export const NOTICE_KIND: Partial<Record<BillingStage, BillingNoticeKind>> = {
  reminder: 'd7',
  urgent: 'd3',
  grace: 'expired',
  restricted: 'restricted',
};

/**
 * Why a reminder can or cannot be sent by hand from the platform console:
 * nothing is due, the platform bot has no token, or the shop linked no chat.
 */
export type ReminderVerdict = 'ok' | 'not_due' | 'no_bot' | 'no_chats';

export function reminderVerdict(input: {
  stage: BillingStage;
  endDate: Date | null;
  botReady: boolean;
  chats: number;
}): ReminderVerdict {
  if (!NOTICE_KIND[input.stage] || !input.endDate) return 'not_due';
  if (!input.botReady) return 'no_bot';
  if (input.chats < 1) return 'no_chats';
  return 'ok';
}

const money = (n: number) =>
  new Intl.NumberFormat('ru-RU').format(Math.round(n)).replace(/\s/g, ' ');

/** DD.MM.YYYY on the Tashkent calendar. */
export function tashkentDate(date: Date | string): string {
  const iso = new Date(
    new Date(date).getTime() + BUSINESS_OFFSET_MS,
  ).toISOString();
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

const MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];

/** "21-noyabr" on the Tashkent calendar — how the day is said aloud. */
export function tashkentDayMonth(date: Date | string): string {
  const iso = new Date(
    new Date(date).getTime() + BUSINESS_OFFSET_MS,
  ).toISOString();
  return `${Number(iso.slice(8, 10))}-${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

const when = (days: number) =>
  days <= 0 ? 'bugun' : days === 1 ? 'ertaga' : `${days} kundan keyin`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The message carries a button that opens the subscription page (see
// billingNoticeButton), so it points at that button and names the section too,
// for whoever reads it in the app's inbox instead.
const PAY =
  "To'lash uchun pastdagi tugmani bosing yoki ilovada “Obuna boshqaruvi” bo'limiga kiring.";
const CONTINUE =
  "pastdagi tugmani bosib, o'zingizga mos tarifni tanlang va “Davom ettirish” tugmasini bosing.";

// The last warning before the end: what happens if nobody pays.
const LOCK_WARNING = `To'lanmasa, tugaganidan ${GRACE_DAYS} kun o'tib KPOS va kassa yopiladi.`;

/** Where the subscription page is: the dashboard's own address. */
export const SUBSCRIPTION_PATH = '/subscription-management';

/** The public address of the dashboard; the button under a notice opens it. */
export function appUrl(): string {
  return (process.env.APP_URL || 'https://kpos.uz').trim().replace(/\/+$/, '');
}

/** The one button under a billing notice: straight to the subscription page. */
export function billingNoticeButton(input: {
  isTrial: boolean;
  base?: string;
}): {text: string; url: string} {
  return {
    text: input.isTrial ? '✅ Tarifni tanlash' : "💳 To'lash",
    url: `${input.base ?? appUrl()}${SUBSCRIPTION_PATH}`,
  };
}

/**
 * A reminder: d7 / d3 before the end, expired (grace), restricted.
 *
 * Written the way a person would tell the owner: what happens and when, what
 * it costs, where to press — and, plainly, that once the grace period is over
 * the whole of KPOS closes, the till included, while the data stays. No "next
 * month": a yearly shop renews for a year.
 */
export function billingNoticeText(input: {
  kind: BillingNoticeKind;
  isTrial: boolean;
  daysLeft: number;
  endDate: Date | string;
  amountDue: number;
  planName: string | null;
  /** Days until KPOS closes, during grace; the whole grace period when not given. */
  graceDaysLeft?: number | null;
}): string {
  const day = tashkentDayMonth(input.endDate);
  const sum = `${money(input.amountDue)} so'm`;
  const closes = `${capital(when(input.graceDaysLeft ?? GRACE_DAYS))} KPOS va kassa yopiladi.`;

  if (input.isTrial) {
    switch (input.kind) {
      case 'expired':
        return [
          `🔴 Bepul sinov davringiz ${day}da tugadi.`,
          `${closes} Davom ettirish uchun ${CONTINUE}`,
        ].join('\n');
      case 'restricted':
        return [
          "⛔ Sinov davri tugagani uchun KPOS vaqtincha yopildi. Ma'lumotlaringiz saqlangan.",
          `Qayta ochish uchun ${CONTINUE}`,
        ].join('\n');
      default:
        return [
          `⏳ Assalomu alaykum! KPOS'dagi bepul sinov davringiz ${when(input.daysLeft)}, ${day}da tugaydi.`,
          `KPOS bilan ishlashda davom etish uchun ${CONTINUE}`,
          ...(input.kind === 'd3' ? [LOCK_WARNING] : []),
        ].join('\n');
    }
  }

  const plan = input.planName ? `“${input.planName}” obunangiz` : 'obunangiz';

  switch (input.kind) {
    case 'expired':
      return [
        `🔴 KPOS'dagi ${plan} ${day}da tugadi.`,
        `${closes} Uzaytirish uchun yana ${sum} kerak.`,
      ].join('\n');
    case 'restricted':
      return [
        "⛔ Obuna to'lanmagani uchun KPOS vaqtincha yopildi. Ma'lumotlaringiz saqlangan.",
        // The payment is approved by hand, so it opens on confirmation, not on transfer.
        `Yana ${sum} to'lang, tasdiqlangach KPOS o'zi ochiladi.`,
      ].join('\n');
    default:
      return [
        `${input.kind === 'd3' ? '⚠️' : '⏳'} Assalomu alaykum! KPOS'dagi ${plan} ${when(input.daysLeft)}, ${day}da tugaydi.`,
        `Uzaytirish uchun balansda yana ${sum} kerak. Balans to'ldirilsa, obuna o'z vaqtida avtomatik uzayadi.`,
        PAY,
        ...(input.kind === 'd3' ? [LOCK_WARNING] : []),
      ].join('\n');
  }
}

/** Q16: one message per successful renewal; warns early if next month is short. */
export function billingRenewedText(input: {
  planName: string;
  periodEnd: Date | string;
  charged: number;
  balanceAfter: number;
  nextShortfall: number;
  /** A year was paid (OBUNA-TOLOV.md §9). */
  yearly?: boolean;
  /** A year was wanted but the balance covered only a month. */
  yearlyFellBack?: boolean;
}): string {
  const lines = [
    `✅ Obuna yangilandi${input.yearly ? ' (1 yilga)' : ''}: ${input.planName}, ${tashkentDate(input.periodEnd)} gacha.`,
    `Balansdan ${money(input.charged)} so'm yechildi. Qoldiq: ${money(input.balanceAfter)} so'm.`,
  ];
  if (input.yearlyFellBack) {
    lines.push(
      "Yillik to'lov uchun balans yetmadi, shuning uchun obuna bir oyga uzaytirildi. Yillik tanlov keyingi to'lovda qayta tekshiriladi.",
    );
  }
  if (input.nextShortfall > 0) {
    lines.push(
      `Keyingi to'lov uchun balansda yana ${money(input.nextShortfall)} so'm kerak bo'ladi.`,
    );
  }
  return lines.join('\n');
}

/** To the platform admins when a shop presses "To'lov qildim". */
export function paymentRequestedText(input: {
  businessName: string;
  amount: number;
  requestedByName: string | null;
  comment: string | null;
  balance: number;
  amountDue: number;
}): string {
  const lines = [
    `💳 Yangi to'lov so'rovi: ${input.businessName}`,
    `Summa: ${money(input.amount)} so'm`,
  ];
  if (input.requestedByName) lines.push(`Kim: ${input.requestedByName}`);
  if (input.comment) lines.push(`Izoh: ${input.comment}`);
  lines.push(
    `Balans: ${money(input.balance)} so'm · yetishmaydi: ${money(input.amountDue)} so'm`,
    "Konsol → To'lovlar",
  );
  return lines.join('\n');
}

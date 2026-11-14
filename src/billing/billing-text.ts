// Telegram texts of the subscription billing notices (OBUNA-TOLOV.md Q8, Q15,
// Q16). Uzbek, like every other message the shop bot sends; phone push gets
// its own uz/ru lines from notification/push-text.ts (event 'billing').

import {BUSINESS_OFFSET_MS} from '../common/business-time';

export type BillingNoticeKind = 'd7' | 'd3' | 'expired' | 'restricted';

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

const when = (days: number) =>
  days <= 0 ? 'bugun' : days === 1 ? 'ertaga' : `${days} kundan keyin`;

const WHERE_TO_PAY = "“Obuna boshqaruvi” bo'limida “To'lash” tugmasini bosing.";

/** A reminder: d7 / d3 before the end, expired (grace), restricted. */
export function billingNoticeText(input: {
  kind: BillingNoticeKind;
  isTrial: boolean;
  daysLeft: number;
  endDate: Date | string;
  amountDue: number;
  planName: string | null;
}): string {
  const end = tashkentDate(input.endDate);
  const plan = input.planName ? ` (${input.planName})` : '';

  if (input.isTrial) {
    switch (input.kind) {
      case 'expired':
        return [
          `🔴 Bepul sinov davri tugadi (${end}).`,
          "3 kun ichida obunani davom ettiring — keyin bo'limlar cheklanadi, kassa esa ishlashda davom etadi.",
          "“Obuna boshqaruvi” bo'limida “Davom ettirish” tugmasini bosing.",
        ].join('\n');
      case 'restricted':
        return [
          "⛔ Sinov davri tugagani uchun bo'limlar cheklandi. Kassa ishlashda davom etadi.",
          "Davom ettirish uchun “Obuna boshqaruvi” bo'limida tarifni tanlang.",
        ].join('\n');
      default:
        return [
          `⏳ Bepul sinov davri ${when(input.daysLeft)} tugaydi (${end}).`,
          "KPOS bilan ishlashni davom ettirish uchun “Obuna boshqaruvi” bo'limida tarifni tanlang va “Davom ettirish” tugmasini bosing.",
        ].join('\n');
    }
  }

  switch (input.kind) {
    case 'expired':
      return [
        `🔴 Obuna${plan} muddati tugadi (${end}).`,
        `3 kundan keyin bo'limlar cheklanadi. To'lanishi kerak: ${money(input.amountDue)} so'm.`,
        WHERE_TO_PAY,
      ].join('\n');
    case 'restricted':
      return [
        "⛔ Obuna to'lanmagani uchun bo'limlar cheklandi. Kassa ishlashda davom etadi.",
        `To'lov qilinishi bilan hammasi darhol tiklanadi. To'lanishi kerak: ${money(input.amountDue)} so'm.`,
        WHERE_TO_PAY,
      ].join('\n');
    default:
      return [
        `${input.kind === 'd3' ? '⚠️' : '⏳'} Obuna${plan} ${when(input.daysLeft)} tugaydi (${end}).`,
        `Keyingi oy uchun balansda ${money(input.amountDue)} so'm yetishmayapti.`,
        WHERE_TO_PAY,
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

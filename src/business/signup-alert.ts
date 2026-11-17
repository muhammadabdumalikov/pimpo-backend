import {BUSINESS_OFFSET_MS} from '../common/business-time';

const TYPE_LABEL: Record<string, string> = {
  retail: "Do'kon",
  food: 'Oshxona (fast-food)',
  online: 'Onlayn sotuvchi',
};

/**
 * The team's Telegram note about a public sign-up (plain text, Uzbek Latin):
 * enough to call the shop. Time is Asia/Tashkent (UTC+5, no DST).
 */
export function signupAlertText(b: {
  name: string;
  phone: string | null;
  login: string;
  businessType: string | null;
  createdAt: Date | null;
}): string {
  const at = (b.createdAt ?? new Date()).getTime() + BUSINESS_OFFSET_MS;
  const when = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  const type = TYPE_LABEL[b.businessType ?? 'retail'] ?? b.businessType ?? "Do'kon";
  return (
    "🆕 Yangi do'kon ro'yxatdan o'tdi\n" +
    `Do'kon: ${b.name}\n` +
    `Telefon: ${b.phone || "yo'q"}\n` +
    `Login: ${b.login}\n` +
    `Turi: ${type}\n` +
    `Vaqt: ${when} (Toshkent)`
  );
}

/**
 * The canonical list of feature flags — features that are rolling out to
 * chosen do'konlar before (or instead of) everyone.
 *
 * Hard rules:
 *  1. A key lands here together with the code that checks it (@RequireFeature
 *     on the endpoints, useFeature() in the UI). The platform console lists
 *     exactly this catalogue, and a switch there that changes nothing is worse
 *     than no switch.
 *  2. Keys are snake_case and stable while the flag lives — they are stored
 *     verbatim in business_feature_flags.
 *  3. A flag is temporary. Once a feature is on for everyone and staying, delete
 *     the entry and its checks; leftover rows in the tables are harmless.
 *
 * Not a flag: what a shop PAYS for. That is the plan tier (@MinTier /
 * PlanTierGuard), a separate axis — a pro-only beta uses both decorators.
 *
 * Adding one:
 *   { key: 'loyalty_checkout', name: "Kassada bonus to'lash",
 *     description: 'Checkout earns and redeems loyalty balance.' },
 */
export interface FeatureDefinition {
  key: string;
  /** Uzbek label for the platform console. */
  name: string;
  /** What turning it on changes, for whoever flips it. */
  description: string;
}

export const FEATURE_CATALOG = [
  {
    key: 'defective_store',
    name: 'Yaroqsiz mahsulotlar ombori',
    description:
      'Yaroqsiz mahsulotlarni alohida omborda saqlash: mijoz qaytargan yaroqsiz ' +
      "mahsulot zarar bo'lib chiqib ketmaydi, omborga tushadi va u yerdan " +
      'hisobdan chiqariladi, sotuvga qaytadi yoki yetkazib beruvchiga ' +
      "qaytariladi. O'chiq do'konda yaroqsiz qaytarish avvalgidek zarar.",
  },
  {
    key: 'live_scale',
    name: 'Jonli tarozi',
    description:
      "Kassa kompyuteriga ulangan tarozi (RS-232 / USB, Chrome yoki Edge'da " +
      "Web Serial orqali) kilogramlik mahsulot og'irligini o'zi yozadi. " +
      "Sozlamalar → Tarozi'da «Shu kompyuterdagi tarozi» bo'limi va kassada " +
      "tarozi belgisi paydo bo'ladi. O'chiq do'konda og'irlik avvalgidek " +
      "qo'lda kiritiladi. Tekshiruv faqat UI'da: server og'irlik manbasini " +
      "flag holatidan qat'i nazar saqlaydi.",
  },
  {
    key: 'pos_quick_grid',
    name: 'Kassada Vitrina',
    description:
      "Kassa toolbar'ida «Vitrina» tugmasi (Alt+V): kilogramlik va " +
      "shtrix-kodsiz mahsulotlar kartochka ko'rinishida, kategoriya chiplari " +
      "bilan. Kartochka bosilganda og'irlik kg yoki so'mda kiritiladi. Bunday " +
      "mahsuloti yo'q do'konda tugma chiqmaydi. Tekshiruv faqat UI'da.",
  },
  {
    key: 'ai_product_image',
    name: 'AI bilan mahsulot rasmi',
    description:
      "Mahsulot kartochkasida «AI bilan yaratish» tugmasi: telefon surati " +
      "yoki nomdan Gemini oq fonli katalog rasmini (packshot) yasaydi. " +
      "Pimpo'ning o'z kalitida ishlaydi — har bir rasm bizga pul, do'konga " +
      "oylik limit ($15 standart, platformada o'zgartiriladi). Biznes " +
      "tarifidan; xodimga «product:image:generate» ruxsati kerak. O'chiq do'konda " +
      'tugma ham, endpointlar ham yo\'q.',
  },
  {
    key: 'ai_assistant',
    name: 'AI yordamchi (Telegram)',
    description:
      "Do'konning o'z Telegram botiga yozgan mijozlarga AI faqat do'kon " +
      "ma'lumotidan javob beradi: mahsulot, sotuv narxi, filial bo'yicha " +
      "bor/yo'q, manzil, ish vaqti, yetkazish. Bilmasa yoki rasm kelsa savol " +
      "ega va «customer:chat:reply» ruxsatli xodimlarga Telegram'da o'tadi. " +
      "Pimpo kalitida, oylik limit bilan; Biznes+ tarifi va ulangan do'kon boti " +
      "kerak. O'chiq do'konda bot jim, sozlamalar sahifasi ham yo'q.",
  },
] as const satisfies readonly FeatureDefinition[];

/** Every key the code may check. `never` while the catalogue is empty. */
export type FeatureKey = (typeof FEATURE_CATALOG)[number]['key'];

const BY_KEY: ReadonlyMap<string, FeatureDefinition> = new Map(
  (FEATURE_CATALOG as readonly FeatureDefinition[]).map((f) => [f.key, f]),
);

/** The catalogue as plain definitions (the typed tuple is only for keys). */
export const FEATURES: readonly FeatureDefinition[] = [...BY_KEY.values()];

export function findFeature(key: string): FeatureDefinition | undefined {
  return BY_KEY.get(key);
}

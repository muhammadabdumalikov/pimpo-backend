/**
 * Canned customer-facing lines of the AI assistant, in the language the
 * customer writes (AI-YORDAMCHI.md Q14). The model writes its own answers;
 * these are the fixed messages around it (handoff, limits, after hours).
 */
export type ChatLocale = 'uz' | 'uzc' | 'ru';

const CYRILLIC = /[Ѐ-ӿ]/;
// Letters only Uzbek Cyrillic has; Russian never uses them.
const UZ_CYRILLIC = /[ўқғҳЎҚҒҲ]/;
// Common Uzbek words written in Cyrillic without the special letters. Matched
// per word: JS `\b` only knows ASCII, so it never fires inside Cyrillic.
const UZ_CYRILLIC_WORDS = new Set([
  'бор', 'борми', 'йук', 'йўқ', 'нарх', 'нархи', 'канча', 'қанча',
  'неча', 'пул', 'рахмат', 'раҳмат', 'салом', 'ассалому', 'алайкум', 'керак',
  'менга', 'сизда', 'сизларда', 'бу', 'шу', 'ва', 'ми', 'мумкинми', 'олсам',
  'олмоқчиман', 'олмокчиман', 'дўкон', 'дукон', 'етказиб', 'соат',
]);

// The Uzbek question particle "-ми" after a consonant (керакми, мумкинми).
// Russian "-ми" words end in a vowel or soft sign (сами, ними, детьми).
// Other suffixes (-да, -га) are left out: когда, дорога, книга are Russian.
const UZ_QUESTION = /[бвгджзйклмнпрстфхцчшщ]ми$/;

export function detectLocale(text: string | null | undefined): ChatLocale {
  const t = text ?? '';
  if (!CYRILLIC.test(t)) return 'uz';
  if (UZ_CYRILLIC.test(t)) return 'uzc';
  const words = t.toLowerCase().split(/[^а-яёўқғҳ]+/u);
  if (words.some((w) => UZ_CYRILLIC_WORDS.has(w) || (w.length > 4 && UZ_QUESTION.test(w)))) {
    return 'uzc';
  }
  return 'ru';
}

type Key =
  | 'handoff'
  | 'handoffPhoto'
  | 'afterHours'
  | 'noAnswerYet'
  | 'rateLimit'
  | 'orderButton'
  | 'greeting'
  | 'failure';

const TEXT: Record<ChatLocale, Record<Key, string>> = {
  uz: {
    handoff: 'Bu savolga operatorimiz tez orada javob beradi.',
    handoffPhoto: "Rasmni ko'rib chiqib, operatorimiz tez orada javob beradi.",
    afterHours:
      "Hozir ish vaqtimiz tugagan. Ish vaqtida albatta javob beramiz{hours}.",
    noAnswerYet:
      "Kechirasiz, operatorlarimiz hozir band. Imkon qadar tezroq javob beramiz.",
    rateLimit: "Savollaringiz ko'p ekan — operatorimiz yordam beradi.",
    orderButton: 'Buyurtma berish',
    greeting:
      "Assalomu alaykum! {shop} yordamchisiman. Mahsulot, narx, qoldiq, " +
      "manzil yoki yetkazib berish haqida so'rang.",
    failure:
      "Kechirasiz, hozir javob bera olmadim. Operatorimiz tez orada yozadi.",
  },
  uzc: {
    handoff: 'Бу саволга операторимиз тез орада жавоб беради.',
    handoffPhoto: 'Расмни кўриб чиқиб, операторимиз тез орада жавоб беради.',
    afterHours:
      'Ҳозир иш вақтимиз тугаган. Иш вақтида албатта жавоб берамиз{hours}.',
    noAnswerYet:
      'Кечирасиз, операторларимиз ҳозир банд. Имкон қадар тезроқ жавоб берамиз.',
    rateLimit: 'Саволларингиз кўп экан — операторимиз ёрдам беради.',
    orderButton: 'Буюртма бериш',
    greeting:
      'Ассалому алайкум! {shop} ёрдамчисиман. Маҳсулот, нарх, қолдиқ, ' +
      'манзил ёки етказиб бериш ҳақида сўранг.',
    failure:
      'Кечирасиз, ҳозир жавоб бера олмадим. Операторимиз тез орада ёзади.',
  },
  ru: {
    handoff: 'На этот вопрос скоро ответит наш оператор.',
    handoffPhoto: 'Оператор посмотрит фото и скоро ответит.',
    afterHours:
      'Сейчас мы не работаем. Обязательно ответим в рабочее время{hours}.',
    noAnswerYet:
      'Извините, операторы сейчас заняты. Ответим как можно скорее.',
    rateLimit: 'Вопросов много — вам поможет наш оператор.',
    orderButton: 'Заказать',
    greeting:
      'Здравствуйте! Я помощник {shop}. Спрашивайте о товарах, ценах, ' +
      'наличии, адресе или доставке.',
    failure:
      'Извините, не получилось ответить. Оператор скоро напишет.',
  },
};

export function t(
  locale: ChatLocale,
  key: Key,
  vars: Record<string, string> = {},
): string {
  return TEXT[locale][key].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

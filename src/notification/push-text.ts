// Push notification texts, one line of title + one of body per event, in the
// language the subscription asked for. The 🔔 inbox does NOT use these: it
// stores `event` + `data` and the client renders them in its own language.

export type NotifyEvent =
  | 'checkout'
  | 'shiftOpened'
  | 'shiftClosed'
  | 'cashOperation'
  | 'dailySales'
  | 'onlineOrder'
  | 'orderCancelled'
  | 'bigDiscount'
  | 'saleReturn'
  | 'lowStock'
  | 'priceChanged'
  | 'test';

/** One inbox/push event. `data.url` is the page a tap opens. */
export interface Notice {
  event: NotifyEvent;
  data: Record<string, unknown> & {url: string};
}

export interface PushText {
  title: string;
  body: string;
}

type Locale = 'uz' | 'ru';
type D = Record<string, unknown>;

const n = (v: unknown) => Number(v) || 0;
const money = (v: unknown) =>
  new Intl.NumberFormat('ru-RU').format(Math.round(n(v))).replace(/ /g, ' ');
const str = (v: unknown) => (v == null ? '' : String(v));
const join = (...parts: unknown[]) => parts.map(str).filter(Boolean).join(' · ');
const receipt = (d: D) => (d.receiptNo != null ? `#${d.receiptNo}` : '');

const TEXT: Record<Locale, Record<NotifyEvent, (d: D) => PushText>> = {
  uz: {
    checkout: (d) => ({
      title: `🧾 Sotuv — ${money(d.total)} so'm`,
      body: join(receipt(d), d.cashierName),
    }),
    shiftOpened: (d) => ({
      title: `🟢 Smena ochildi — ${str(d.registerName)}`,
      body: join(d.cashierName, `boshlang'ich ${money(d.openingFloat)} so'm`),
    }),
    shiftClosed: (d) => ({
      title: `🔴 Smena yopildi — ${str(d.registerName)}`,
      body: join(
        d.diff == null
          ? ''
          : n(d.diff) < 0
            ? `⚠️ Kamomad ${money(-n(d.diff))} so'm`
            : n(d.diff) > 0
              ? `Ortiqcha ${money(d.diff)} so'm`
              : 'Kassa mos keldi',
        d.cashierName,
      ),
    }),
    cashOperation: (d) => ({
      title: `${d.direction === 'in' ? '💵 Kassa kirim' : '💸 Kassa chiqim'} — ${money(d.amount)} ${d.currency === 'USD' ? '$' : "so'm"}`,
      body: join(d.note, d.cashierName),
    }),
    dailySales: (d) => ({
      title: `📊 Kunlik yakun — ${money(d.revenue)} so'm`,
      body: join(
        `${n(d.orderCount)} ta chek`,
        d.profit != null ? `foyda ${money(d.profit)} so'm` : '',
      ),
    }),
    onlineOrder: (d) => ({
      title: `🛒 Yangi onlayn buyurtma — ${money(d.total)} so'm`,
      body: join(d.customerName, d.itemCount != null ? `${n(d.itemCount)} ta tovar` : ''),
    }),
    orderCancelled: (d) => ({
      title: `🚩 Chek bekor qilindi — ${money(d.total)} so'm`,
      body: join(receipt(d), d.by),
    }),
    bigDiscount: (d) => ({
      title: `🚩 Katta chegirma — ${Math.round(n(d.pct))}%`,
      body: join(receipt(d), `−${money(d.discount)} so'm`, d.by),
    }),
    saleReturn: (d) => ({
      title: `🚩 Qaytarish — ${money(d.total)} so'm`,
      body: join(receipt(d), d.by),
    }),
    lowStock: (d) => ({
      title:
        n(d.low) > 0
          ? `📦 ${n(d.out)} ta tovar tugadi, ${n(d.low)} tasi kam qoldi`
          : `📦 ${n(d.out)} ta tovar tugadi`,
      body: Array.isArray(d.names) ? d.names.join(', ') : '',
    }),
    priceChanged: (d) => ({
      title:
        n(d.count) > 1
          ? `🏷 ${n(d.count)} ta tovar arzonlashdi — etiketkani almashtiring`
          : `🏷 ${str(d.name)}: ${money(d.from)} → ${money(d.to)} so'm`,
      body:
        n(d.count) > 1
          ? Array.isArray(d.names) ? d.names.join(', ') : ''
          : "Eski qoldiq tugadi — etiketkani almashtiring",
    }),
    test: () => ({
      title: 'KPOS',
      body: 'Bildirishnomalar ishlayapti ✅',
    }),
  },
  ru: {
    checkout: (d) => ({
      title: `🧾 Продажа — ${money(d.total)} сум`,
      body: join(receipt(d), d.cashierName),
    }),
    shiftOpened: (d) => ({
      title: `🟢 Смена открыта — ${str(d.registerName)}`,
      body: join(d.cashierName, `на начало ${money(d.openingFloat)} сум`),
    }),
    shiftClosed: (d) => ({
      title: `🔴 Смена закрыта — ${str(d.registerName)}`,
      body: join(
        d.diff == null
          ? ''
          : n(d.diff) < 0
            ? `⚠️ Недостача ${money(-n(d.diff))} сум`
            : n(d.diff) > 0
              ? `Излишек ${money(d.diff)} сум`
              : 'Касса сошлась',
        d.cashierName,
      ),
    }),
    cashOperation: (d) => ({
      title: `${d.direction === 'in' ? '💵 Приход в кассу' : '💸 Расход из кассы'} — ${money(d.amount)} ${d.currency === 'USD' ? '$' : 'сум'}`,
      body: join(d.note, d.cashierName),
    }),
    dailySales: (d) => ({
      title: `📊 Итоги дня — ${money(d.revenue)} сум`,
      body: join(
        `${n(d.orderCount)} чеков`,
        d.profit != null ? `прибыль ${money(d.profit)} сум` : '',
      ),
    }),
    onlineOrder: (d) => ({
      title: `🛒 Новый онлайн-заказ — ${money(d.total)} сум`,
      body: join(d.customerName, d.itemCount != null ? `${n(d.itemCount)} товаров` : ''),
    }),
    orderCancelled: (d) => ({
      title: `🚩 Чек отменён — ${money(d.total)} сум`,
      body: join(receipt(d), d.by),
    }),
    bigDiscount: (d) => ({
      title: `🚩 Большая скидка — ${Math.round(n(d.pct))}%`,
      body: join(receipt(d), `−${money(d.discount)} сум`, d.by),
    }),
    saleReturn: (d) => ({
      title: `🚩 Возврат — ${money(d.total)} сум`,
      body: join(receipt(d), d.by),
    }),
    lowStock: (d) => ({
      title:
        n(d.low) > 0
          ? `📦 Закончилось ${n(d.out)} товаров, мало — ${n(d.low)}`
          : `📦 Закончилось ${n(d.out)} товаров`,
      body: Array.isArray(d.names) ? d.names.join(', ') : '',
    }),
    priceChanged: (d) => ({
      title:
        n(d.count) > 1
          ? `🏷 Подешевело товаров: ${n(d.count)} — замените ценники`
          : `🏷 ${str(d.name)}: ${money(d.from)} → ${money(d.to)} сум`,
      body:
        n(d.count) > 1
          ? Array.isArray(d.names) ? d.names.join(', ') : ''
          : 'Старый остаток распродан — замените ценник',
    }),
    test: () => ({
      title: 'KPOS',
      body: 'Уведомления работают ✅',
    }),
  },
};

export function pushLocale(locale: string | null | undefined): Locale {
  return locale === 'ru' ? 'ru' : 'uz';
}

export function renderPush(notice: Notice, locale: string): PushText {
  return TEXT[pushLocale(locale)][notice.event](notice.data);
}

/** Announcement title/body are stored per language; fall back to Uzbek. */
export function pickLocalized(
  text: Record<string, string | undefined> | null | undefined,
  locale: string,
): string {
  if (!text) return '';
  return text[pushLocale(locale)] || text.uz || text.ru || text.en || '';
}

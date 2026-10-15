// Customer-facing Telegram messages for a storefront order (YETKAZISH.md §5),
// in the language the customer shopped in (Q20). Pure — no DB, no sending —
// so the wording is unit-tested in store-order-messages.spec.ts.

export type StoreLocale = 'uz' | 'uzc' | 'ru' | 'en';

export type StoreOrderMessageKind =
  | 'Assembling'
  | 'Delivering'
  | 'ReadyForPickup'
  | 'Completed'
  | 'Cancelled'
  | 'ItemsChanged';

export interface StoreOrderMessage {
  kind: StoreOrderMessageKind;
  locale?: string | null;
  orderId: string;
  shopName?: string | null;
  deliveryType: 'pickup' | 'delivery';
  itemCount?: number | null;
  totalAmount: string | number;
  deliveryFee?: string | number | null;
  courierName?: string | null;
  courierPhone?: string | null;
  pickupBranchName?: string | null;
  pickupAddress?: string | null;
  cancelReason?: string | null;
  cancelNote?: string | null;
  // Lines trimmed while assembling: quantity before → after (0 = removed).
  changes?: {name: string; from: number; to: number}[];
}

type Dict = {
  assembling: string;
  delivering: string;
  ready: string;
  delivered: string;
  pickedUp: string;
  cancelled: string;
  changed: string;
  order: string;
  goods: (n: string) => string;
  delivery: string;
  pay: string;
  som: string;
  courier: string;
  reason: string;
  removed: string;
  reasons: Record<string, string>;
};

const DICTS: Record<StoreLocale, Dict> = {
  uz: {
    assembling: "✅ Buyurtmangiz qabul qilindi va yig'ilmoqda",
    delivering: "🚚 Buyurtmangiz yo'lda",
    ready: '🏪 Buyurtmangiz tayyor, olib ketishingiz mumkin',
    delivered: '📦 Buyurtmangiz yetkazildi. Xaridingiz uchun rahmat!',
    pickedUp: '📦 Buyurtmangiz topshirildi. Xaridingiz uchun rahmat!',
    cancelled: '❌ Buyurtmangiz bekor qilindi',
    changed: "✏️ Buyurtmangiz o'zgartirildi",
    order: 'Buyurtma',
    goods: (n) => `Tovarlar: ${n} dona`,
    delivery: 'Yetkazish',
    pay: "To'lov",
    som: "so'm",
    courier: 'Kuryer',
    reason: 'Sabab',
    removed: 'olib tashlandi',
    reasons: {
      customer_refused: 'buyurtmadan voz kechildi',
      no_answer: "siz bilan bog'lana olmadik",
      out_of_stock: 'tovar qolmagan',
    },
  },
  uzc: {
    assembling: '✅ Буюртмангиз қабул қилинди ва йиғилмоқда',
    delivering: '🚚 Буюртмангиз йўлда',
    ready: '🏪 Буюртмангиз тайёр, олиб кетишингиз мумкин',
    delivered: '📦 Буюртмангиз етказилди. Харидингиз учун раҳмат!',
    pickedUp: '📦 Буюртмангиз топширилди. Харидингиз учун раҳмат!',
    cancelled: '❌ Буюртмангиз бекор қилинди',
    changed: '✏️ Буюртмангиз ўзгартирилди',
    order: 'Буюртма',
    goods: (n) => `Товарлар: ${n} дона`,
    delivery: 'Етказиш',
    pay: 'Тўлов',
    som: 'сўм',
    courier: 'Курьер',
    reason: 'Сабаб',
    removed: 'олиб ташланди',
    reasons: {
      customer_refused: 'буюртмадан воз кечилди',
      no_answer: 'сиз билан боғлана олмадик',
      out_of_stock: 'товар қолмаган',
    },
  },
  ru: {
    assembling: '✅ Ваш заказ принят и собирается',
    delivering: '🚚 Ваш заказ в пути',
    ready: '🏪 Ваш заказ готов, можно забирать',
    delivered: '📦 Ваш заказ доставлен. Спасибо за покупку!',
    pickedUp: '📦 Ваш заказ выдан. Спасибо за покупку!',
    cancelled: '❌ Ваш заказ отменён',
    changed: '✏️ Ваш заказ изменён',
    order: 'Заказ',
    goods: (n) => `Товары: ${n} шт.`,
    delivery: 'Доставка',
    pay: 'К оплате',
    som: 'сум',
    courier: 'Курьер',
    reason: 'Причина',
    removed: 'удалено',
    reasons: {
      customer_refused: 'отказ от заказа',
      no_answer: 'не удалось с вами связаться',
      out_of_stock: 'товара нет в наличии',
    },
  },
  en: {
    assembling: '✅ Your order was accepted and is being packed',
    delivering: '🚚 Your order is on its way',
    ready: '🏪 Your order is ready for pickup',
    delivered: '📦 Your order was delivered. Thank you for your purchase!',
    pickedUp: '📦 Your order was handed over. Thank you for your purchase!',
    cancelled: '❌ Your order was cancelled',
    changed: '✏️ Your order was changed',
    order: 'Order',
    goods: (n) => `Items: ${n} pcs`,
    delivery: 'Delivery',
    pay: 'To pay',
    som: "so'm",
    courier: 'Courier',
    reason: 'Reason',
    removed: 'removed',
    reasons: {
      customer_refused: 'the order was refused',
      no_answer: 'we could not reach you',
      out_of_stock: 'out of stock',
    },
  },
};

export function storeLocale(locale?: string | null): StoreLocale {
  return locale === 'uzc' || locale === 'ru' || locale === 'en' ? locale : 'uz';
}

// Same grouping as the rest of the bot messages (space-separated thousands).
const money = (n: number | string | null | undefined) =>
  new Intl.NumberFormat('uz-UZ').format(Math.round(Number(n) || 0));
const qty = (n: number | string | null | undefined) =>
  new Intl.NumberFormat('uz-UZ', {maximumFractionDigits: 3}).format(
    Number(n) || 0,
  );

/** The message text, or null when this move is not worth a message. */
export function buildStoreOrderMessage(m: StoreOrderMessage): string | null {
  const t = DICTS[storeLocale(m.locale)];
  const lines: string[] = [];

  switch (m.kind) {
    case 'Assembling':
      lines.push(t.assembling);
      break;
    case 'Delivering':
      lines.push(t.delivering);
      if (m.courierName) {
        lines.push('', `🧑 ${t.courier}: ${m.courierName}`);
        if (m.courierPhone) lines.push(`📞 ${m.courierPhone}`);
      }
      break;
    case 'ReadyForPickup': {
      lines.push(t.ready);
      const place = [m.pickupBranchName, m.pickupAddress]
        .filter(Boolean)
        .join(', ');
      if (place) lines.push('', `📍 ${place}`);
      break;
    }
    case 'Completed':
      lines.push(m.deliveryType === 'delivery' ? t.delivered : t.pickedUp);
      break;
    case 'Cancelled': {
      // The customer pressed cancel themselves — they already know.
      if (m.cancelReason === 'customer_cancelled') return null;
      lines.push(t.cancelled);
      const why =
        m.cancelReason === 'other'
          ? m.cancelNote
          : (t.reasons[m.cancelReason ?? ''] ?? m.cancelNote);
      if (why) lines.push(`${t.reason}: ${why}`);
      break;
    }
    case 'ItemsChanged':
      if (!m.changes?.length) return null;
      lines.push(t.changed, '');
      for (const c of m.changes) {
        lines.push(
          c.to > 0
            ? `➖ ${c.name}: ${qty(c.from)} → ${qty(c.to)}`
            : `➖ ${c.name}: ${t.removed}`,
        );
      }
      break;
  }

  const fee = Number(m.deliveryFee) || 0;
  lines.push('', `🧾 ${t.order}: #${m.orderId.slice(0, 8).toUpperCase()}`);
  if (m.itemCount != null) lines.push(`📦 ${t.goods(qty(m.itemCount))}`);
  if (fee > 0) lines.push(`🚚 ${t.delivery}: ${money(fee)} ${t.som}`);
  lines.push(
    `💰 ${t.pay}: ${money((Number(m.totalAmount) || 0) + fee)} ${t.som}`,
  );
  if (m.shopName) lines.push('', `🏪 ${m.shopName}`);
  return lines.join('\n');
}

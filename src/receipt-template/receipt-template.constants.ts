// Field keys allowed in a receipt template's info block, in canonical order.
// Both the DTO validation and the default template seed reference these.
export const INFO_FIELD_KEYS = [
  'storeName',
  'date',
  'workTime',
  'seller',
  'cashier',
  'customer',
  'contacts',
  'customerPhone',
  'saleComment',
  'inn',
  'legalName',
  'address',
  'productCount',
  'showProducts',
  'itemDiscounts',
  'itemSums',
  'receiptDiscounts',
  'receiptSums',
] as const;

// Bottom-block keys (socials + barcode), in canonical order.
export const FOOTER_LINK_KEYS = [
  'facebook',
  'instagram',
  'telegram',
  'website',
  'barcode',
] as const;

export type InfoFieldKey = (typeof INFO_FIELD_KEYS)[number];
export type FooterLinkKey = (typeof FOOTER_LINK_KEYS)[number];

export interface FieldConfig {
  key: string;
  enabled: boolean;
  // Only used by footer links (social handle / url); ignored for info fields.
  value?: string;
}

// Default field configuration for a freshly-created template. Kept in sync with
// the seed in migration 0016.
export const DEFAULT_INFO_FIELDS: FieldConfig[] = [
  {key: 'storeName', enabled: true},
  {key: 'date', enabled: true},
  {key: 'workTime', enabled: false},
  {key: 'seller', enabled: false},
  {key: 'cashier', enabled: true},
  {key: 'customer', enabled: true},
  {key: 'contacts', enabled: false},
  {key: 'customerPhone', enabled: false},
  {key: 'saleComment', enabled: false},
  {key: 'inn', enabled: false},
  {key: 'legalName', enabled: false},
  {key: 'address', enabled: false},
  {key: 'productCount', enabled: true},
  {key: 'showProducts', enabled: true},
  {key: 'itemDiscounts', enabled: false},
  {key: 'itemSums', enabled: true},
  {key: 'receiptDiscounts', enabled: true},
  {key: 'receiptSums', enabled: true},
];

export const DEFAULT_FOOTER_LINKS: FieldConfig[] = [
  {key: 'facebook', enabled: false, value: ''},
  {key: 'instagram', enabled: false, value: ''},
  {key: 'telegram', enabled: false, value: ''},
  {key: 'website', enabled: false, value: ''},
  {key: 'barcode', enabled: true, value: ''},
];

export const DEFAULT_FOOTER_TEXT = 'Спасибо за вашу покупку!';

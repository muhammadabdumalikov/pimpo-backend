import {
  INVOICE_PLATFORM_PAGES,
  fitsAllowance,
  platformInvoiceConfig,
  platformPageLimit,
} from './invoice-quota';

const ids = ['anthropic', 'openai', 'gemini'] as const;
const defaultModelFor = (p: string) => `${p}-default`;

describe('scanner allowance on the platform key', () => {
  it('gives Business 100 pages and Business+ 500', () => {
    expect(platformPageLimit('pro')).toBe(100);
    expect(platformPageLimit('proplus')).toBe(500);
    expect(INVOICE_PLATFORM_PAGES).toEqual({pro: 100, proplus: 500});
  });

  it('gives plans without the scanner nothing', () => {
    expect(platformPageLimit('basic')).toBe(0);
    expect(platformPageLimit('free')).toBe(0);
    expect(platformPageLimit('food')).toBe(0);
  });

  it('lets a read through only when every page fits', () => {
    expect(fitsAllowance(100, 0, 6)).toBe(true);
    expect(fitsAllowance(100, 94, 6)).toBe(true);
    expect(fitsAllowance(100, 95, 6)).toBe(false);
    expect(fitsAllowance(100, 100, 1)).toBe(false);
    expect(fitsAllowance(0, 0, 1)).toBe(false);
  });
});

describe('platformInvoiceConfig', () => {
  it('defaults to gemini and its default model', () => {
    expect(
      platformInvoiceConfig({GEMINI_API_KEY: ' g '}, ids, defaultModelFor),
    ).toEqual({provider: 'gemini', model: 'gemini-default', key: 'g'});
  });

  it('follows the configured provider, model and that provider’s key', () => {
    expect(
      platformInvoiceConfig(
        {
          AI_INVOICE_PROVIDER: 'anthropic',
          AI_INVOICE_MODEL: 'claude-haiku-4-5',
          ANTHROPIC_API_KEY: 'a',
          GEMINI_API_KEY: 'g',
        },
        ids,
        defaultModelFor,
      ),
    ).toEqual({provider: 'anthropic', model: 'claude-haiku-4-5', key: 'a'});
  });

  it('falls back to gemini on an unknown provider and reports a missing key', () => {
    expect(
      platformInvoiceConfig({AI_INVOICE_PROVIDER: 'nope'}, ids, defaultModelFor),
    ).toEqual({provider: 'gemini', model: 'gemini-default', key: undefined});
  });
});

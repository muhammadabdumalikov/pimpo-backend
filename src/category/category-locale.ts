import {createParamDecorator, ExecutionContext} from '@nestjs/common';

/**
 * The language a global category's name is read in (AI-SOZLASH.md §3).
 * The four the dashboard ships: Uzbek Latin, Uzbek Cyrillic, Russian, English.
 */
export type CatalogLocale = 'uz' | 'uzc' | 'ru' | 'en';

/**
 * The caller's language from an `Accept-Language` value. The dashboard sends
 * its app language (`uz`, `uz-Cyrl`, `ru`, `en`); a browser's own header
 * (`ru-RU,ru;q=0.9,…`) works too. Only the first tag counts — the first is the
 * one the person chose. Anything else reads as Uzbek Latin, the default.
 */
export function parseCatalogLocale(header: string | null | undefined): CatalogLocale {
  const first = (header ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  if (first === 'uzc' || first.startsWith('uz-cyrl')) return 'uzc';
  if (first.startsWith('ru')) return 'ru';
  if (first.startsWith('en')) return 'en';
  return 'uz';
}

/** Explicit `?locale=` (the storefront) wins over the header. */
export function catalogLocaleOf(
  query: string | null | undefined,
  header: string | null | undefined,
): CatalogLocale {
  if (query === 'uz' || query === 'uzc' || query === 'ru' || query === 'en') return query;
  return parseCatalogLocale(header);
}

/** `@ReqLocale() locale: CatalogLocale` — the caller's catalogue language. */
export const ReqLocale = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CatalogLocale => {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      query?: Record<string, unknown>;
    }>();
    const header = req.headers['accept-language'];
    const query = req.query?.locale;
    return catalogLocaleOf(
      typeof query === 'string' ? query : undefined,
      Array.isArray(header) ? header[0] : header,
    );
  },
);

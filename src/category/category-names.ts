import {sql, SQL} from 'drizzle-orm';

/**
 * A category's display name in SQL, for queries that read it next to other
 * data (reports, the Billz import, banners).
 *
 * A shop's own category carries its name; a row that links a global category
 * has `name` NULL and the name lives in global_categories (AI-SOZLASH.md §3).
 * These queries are cached without the viewer's language, so they read the
 * Uzbek Latin name — the default. Lists the owner reads in their own language
 * (GET /categories, the storefront) resolve names in code instead
 * (GlobalCatalogService.nameOf).
 *
 * Identifiers are spelled out: inside the subquery a bare `global_key` would
 * still bind to categories, but `"categories"."global_key"` cannot drift if
 * the query ever aliases the table.
 */
export const CATEGORY_NAME_SQL: SQL<string | null> = sql<string | null>`coalesce(
  "categories"."name",
  (SELECT gc.name_uz FROM global_categories gc WHERE gc.key = "categories"."global_key")
)`;

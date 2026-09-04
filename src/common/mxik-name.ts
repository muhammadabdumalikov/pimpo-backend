/**
 * tasnif.soliq.uz names every classifier row as "<class>: <brand>, <attributes>",
 * e.g. "Бошқа нон турлари: Flint, кабоб таъмли 60 г". The part before the colon
 * is the classifier's own class — a category, not what a shopkeeper calls the
 * product. Copying the raw name into `products.name` (which the barcode lookup
 * used to do) is how a catalog ends up with rows literally named
 * "Бошқа нон турлари: Flint, кабоб таъмли 60 г".
 *
 * 288 624 of the 382 873 classifier rows carry such a prefix; the remaining
 * ~94k have no colon and pass through unchanged. Every distinct prefix in the
 * data is a real class name (the shortest are "Ароқ", "Вино", "Пиво"), so
 * splitting on the FIRST ": " is safe — no length heuristic needed. The only
 * guard is against a suffix too short to stand on its own as a name (5 rows).
 */
export function mxikDisplayName(name: string): string {
  const trimmed = name.trim();
  const sep = trimmed.indexOf(': ');
  if (sep < 0) return trimmed;
  const suffix = trimmed.slice(sep + 2).trim();
  return suffix.length >= 3 ? suffix : trimmed;
}

/**
 * The class prefix on its own ("Бошқа нон турлари"), or null when the row has
 * none. More specific than `groupName` (18 top-level groups), so it is the
 * better category hint when suggesting one for a scanned product.
 */
export function mxikClassName(name: string): string | null {
  const trimmed = name.trim();
  const sep = trimmed.indexOf(': ');
  if (sep < 0) return null;
  const suffix = trimmed.slice(sep + 2).trim();
  if (suffix.length < 3) return null;
  const prefix = trimmed.slice(0, sep).trim();
  return prefix || null;
}

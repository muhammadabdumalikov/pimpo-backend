/**
 * Prompt templates for AI product packshots (AI-RASM.md).
 *
 * Pure strings and functions, no Nest: the bake-off script in scripts/ runs
 * the exact same prompts the endpoint does.
 *
 * The packshot wording is the owner's "Universal POS Packshot Prompt" with its
 * two `image_42.png` / `image_43.png` references taken out (Q5) — they pointed
 * at pictures in another chat that an API call never sees. Bump
 * PACKSHOT_PROMPT_VERSION whenever a template changes, so a run of bad images
 * can be traced to the wording it ran on.
 */

export const PACKSHOT_PROMPT_VERSION = 'v3';

/** Longest packaging description we send. The tips in the prompt need ~30 words. */
export const MAX_DESCRIPTION_LENGTH = 600;

/** The house style both modes end on. */
const STUDIO_STYLE =
  'The product stands perfectly upright and is centered, facing straight ' +
  'forward for a direct, standard eye-level view. The branding, logos, and ' +
  'critical text details are in incredibly sharp focus, completely unblurred. ' +
  'The product is totally isolated on a spotless, pure white background with ' +
  'absolutely no secondary objects, textures, or distractors. Studio lighting ' +
  'is bright, even, and highly diffused, creating soft, natural highlights on ' +
  'any gloss and a clean, shadowless look. Hyperrealistic packshot quality, ' +
  '8k resolution.';

/**
 * Text mode: the model has only the description, so the packaging it draws is
 * its own guess (the UI says so before the shop accepts it).
 */
export function textPackshotPrompt(description: string): string {
  return (
    'A high-resolution, professional studio product photograph of ' +
    `${cleanDescription(description)}. ${STUDIO_STYLE}`
  );
}

/**
 * Photo mode: the shop's own photo of the real pack is the authority. The
 * failure we guard against is the model "improving" the label — a new word, a
 * translated name, a tidier logo — which would put a pack on the till that is
 * not the one on the shelf.
 */
export function photoPackshotPrompt(description: string): string {
  return (
    'Turn the product in the attached photo into a high-resolution, ' +
    'professional studio product photograph. The product is ' +
    `${cleanDescription(description)}. ` +
    'Keep the product exactly as it appears in the photo: the same packaging ' +
    'shape, proportions, colours, logos, artwork and every printed word, ' +
    'letter for letter. Do not invent, translate, add or remove any text, ' +
    'logo or graphic; where a detail is unreadable in the photo, keep it ' +
    'subtle rather than making one up. Remove everything that is not the ' +
    'product — hands, shelves, price tags, other products, reflections and ' +
    `the original background. ${STUDIO_STYLE}`
  );
}

/**
 * System prompt for the cheap text step that drafts the description (Q4).
 *
 * Shop catalogues name goods the way the supplier's nakladnoy does: Russian or
 * Uzbek, Cyrillic, with packaging shorthand. Spelling the common shorthand out
 * is what turns "МариМолоко 350гр п/б" into something an image model can draw.
 */
export const DESCRIBE_SYSTEM_PROMPT = [
  'You write the packaging description that is inserted into a product',
  'packshot prompt for a point-of-sale catalogue.',
  '',
  'Reply with ONE English noun phrase of at most 45 words and nothing else —',
  'no quotes, no full stop, no preamble. Cover, when known: brand, product',
  'type, flavour or variant, net size (weight, volume or count), packaging',
  'material and form, dominant colours, and the notable graphics or text on',
  'the pack. Example: "Milka Alpine Milk Chocolate Bar, in its classic purple',
  'wrapper, showing the Milka logo and the cow graphic, 100g size".',
  '',
  'Describe ONE retail unit exactly as a shopper sees it on the shelf.',
  'Shop catalogue names carry things that are not on the pack — leave them out:',
  '• Case and pack counts from the supplier ("10*160 г", "12x0,5л", "24 шт/кор",',
  '  "уп. 6", "блок", "48шт"): use only the unit size (160 g) and never say how',
  '  many units a case holds — unless the product itself is a multipack.',
  '• Internal codes, article/SKU numbers, prices, dates, shelf or warehouse',
  '  marks, supplier or shop notes, duplicate markers ("(2)", "копия").',
  '• Promo words: акция, скидка, хит, новинка, ТОП, NEW, yangi, aksiya, chegirma.',
  'Keep what identifies the product: brand, product type, flavour or variant,',
  'unit size.',
  '',
  'When a photo is attached it is the authority: describe what you see on that',
  'pack, and copy brand names and printed words exactly as written, keeping',
  'their original alphabet. Without a photo, work from the product name and',
  'never invent a brand that the name does not contain.',
  '',
  'Product names are often Russian or Uzbek, in Cyrillic, with shorthand:',
  'гр/г = g, кг = kg, мл = ml, л = l, шт = pieces, п/б or пл/б = plastic',
  'bottle, пэт = PET bottle, ст/б = glass bottle, ж/б = tin can, т/п = Tetra',
  'Pak carton, д/п or дой-пак = stand-up doypack pouch, п/э or пл/п = plastic',
  'film pouch, м/у = soft pack, к/у = cardboard box, в/у = vacuum pack.',
].join('\n');

/** The user turn for the describe step. */
export function describeInstruction(input: {
  name: string;
  brand?: string | null;
  category?: string | null;
  unit?: string | null;
  hasPhoto: boolean;
}): string {
  const lines = [`Product name: ${input.name.trim()}`];
  if (input.brand?.trim()) lines.push(`Brand: ${input.brand.trim()}`);
  if (input.category?.trim()) lines.push(`Category: ${input.category.trim()}`);
  if (input.unit?.trim()) lines.push(`Sold by: ${input.unit.trim()}`);
  lines.push(
    input.hasPhoto
      ? 'A photo of the product is attached.'
      : 'There is no photo.',
  );
  return lines.join('\n');
}

/**
 * One line, no stray punctuation at the end, capped. The description is the
 * shop's own text (they may have corrected it in Uzbek or Russian); it only
 * ever reaches the image model, so it needs tidying rather than escaping.
 */
export function cleanDescription(raw: string): string {
  const flat = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^["'«“]+|["'»”]+$/g, '')
    .replace(/[.\s]+$/, '');
  return flat.length > MAX_DESCRIPTION_LENGTH
    ? flat.slice(0, MAX_DESCRIPTION_LENGTH).trim()
    : flat;
}

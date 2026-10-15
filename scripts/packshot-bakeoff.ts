/**
 * AI packshot bake-off (AI-RASM.md R0): runs real product photos through the
 * exact prompts the endpoint uses, on one or more models, and writes a
 * side-by-side contact sheet.
 *
 *   GEMINI_API_KEY=... pnpm ai:packshot-bakeoff ./photos
 *   GEMINI_API_KEY=... pnpm ai:packshot-bakeoff ./photos \
 *     --models gemini-nano-banana-2.1,gemini-3-pro-image \
 *     --thinking minimal,medium --text --out ./bakeoff
 *
 * Each photo's file name is the product name as the shop wrote it
 * ("МариМолоко 350гр п/б.jpg" — a slash can't be in a file name, write "п-б"
 * and it is turned back). Per photo: one describe call, then one photo-mode
 * packshot per model × thinking level, plus one text-mode packshot (no photo)
 * with --text, to see how far the guess is from the real pack.
 *
 * The question it answers before the feature ships: does the model keep the
 * label — every printed word — exactly as on the shelf? Open index.html.
 *
 * Costs real money on the platform key; the total is printed at the end.
 */
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {basename, extname, join, resolve} from 'node:path';
import {
  DEFAULT_DESCRIBE_MODEL,
  DEFAULT_IMAGE_MODEL,
  imageCallCostUsd,
} from '../src/ai/image/ai-image.pricing';
import {
  GeminiImageClient,
  parseThinkingLevel,
} from '../src/ai/image/gemini-image.client';
import {
  prepareInputPhoto,
  toPackshotWebp,
} from '../src/ai/image/packshot-image';
import {
  DESCRIBE_SYSTEM_PROMPT,
  PACKSHOT_PROMPT_VERSION,
  cleanDescription,
  describeInstruction,
  photoPackshotPrompt,
  textPackshotPrompt,
} from '../src/ai/image/packshot-prompt';
import {estimateCostUsd} from '../src/ai/providers/llm-provider.interface';

const MIMES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

interface Cell {
  label: string;
  file: string | null;
  note: string;
  costUsd: number;
  ms: number;
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  const dir = process.argv[2];
  if (!key || !dir || dir.startsWith('--')) {
    console.error(
      'GEMINI_API_KEY=... pnpm ai:packshot-bakeoff <photosDir> [--models a,b] [--thinking minimal,medium] [--text] [--out dir]',
    );
    process.exit(2);
  }
  const models = (arg('models') ?? DEFAULT_IMAGE_MODEL)
    .split(',')
    .map((m) => m.trim());
  const levels = (arg('thinking') ?? 'default').split(',').map((t) => t.trim());
  const withText = process.argv.includes('--text');
  const out = resolve(arg('out') ?? './packshot-bakeoff');
  mkdirSync(out, {recursive: true});

  const client = GeminiImageClient.fromKey(key);
  const photos = readdirSync(dir).filter(
    (f) => MIMES[extname(f).toLowerCase()],
  );
  if (!photos.length) throw new Error(`No photos in ${dir}`);

  let total = 0;
  const rows: {
    name: string;
    original: string;
    description: string;
    cells: Cell[];
  }[] = [];

  for (const [i, file] of photos.entries()) {
    const name = basename(file, extname(file)).replace(/(\S)-(\S)/g, '$1/$2');
    const src = {
      data: readFileSync(join(dir, file)),
      mimeType: MIMES[extname(file).toLowerCase()],
    };
    const photo = await prepareInputPhoto(src);
    const original = `${i}-original.jpg`;
    writeFileSync(join(out, original), photo.data);
    console.log(`\n[${i + 1}/${photos.length}] ${name}`);

    const t0 = Date.now();
    const d = await client.describe({
      model: DEFAULT_DESCRIBE_MODEL,
      system: DESCRIBE_SYSTEM_PROMPT,
      instruction: describeInstruction({name, hasPhoto: true}),
      photo,
    });
    const description = cleanDescription(d.text) || name;
    const dCost = estimateCostUsd(
      DEFAULT_DESCRIBE_MODEL,
      'gemini',
      d.inputTokens,
      d.outputTokens,
    );
    total += dCost;
    console.log(
      `  describe (${Date.now() - t0} ms, $${dCost.toFixed(5)}): ${description}`,
    );

    const cells: Cell[] = [];
    const runs: {model: string; level: string; usePhoto: boolean}[] = [];
    for (const model of models)
      for (const level of levels) runs.push({model, level, usePhoto: true});
    if (withText)
      runs.push({model: models[0], level: levels[0], usePhoto: false});

    for (const run of runs) {
      const label = `${run.usePhoto ? 'foto' : 'MATN'} · ${run.model} · ${run.level}`;
      const started = Date.now();
      try {
        const res = await client.generate({
          model: run.model,
          prompt: run.usePhoto
            ? photoPackshotPrompt(description)
            : textPackshotPrompt(description),
          photo: run.usePhoto ? photo : undefined,
          thinkingLevel: parseThinkingLevel(run.level),
        });
        const ms = Date.now() - started;
        const cost = imageCallCostUsd(run.model, res.usage);
        total += cost;
        if (!res.image) {
          cells.push({
            label,
            file: null,
            note: res.blockReason ?? res.finishReason ?? 'NO_IMAGE',
            costUsd: cost,
            ms,
          });
          console.log(
            `  ${label}: no image (${res.finishReason}) ${ms} ms $${cost.toFixed(4)}`,
          );
          continue;
        }
        const f = `${i}-${cells.length}.webp`;
        writeFileSync(join(out, f), await toPackshotWebp(res.image));
        cells.push({
          label,
          file: f,
          note: `${res.usage.textTokens} thinking/text tok`,
          costUsd: cost,
          ms,
        });
        console.log(`  ${label}: ${ms} ms $${cost.toFixed(4)}`);
      } catch (err) {
        cells.push({
          label,
          file: null,
          note: (err as Error).message.slice(0, 160),
          costUsd: 0,
          ms: Date.now() - started,
        });
        console.log(`  ${label}: ERROR ${(err as Error).message}`);
      }
    }
    rows.push({name, original, description, cells});
  }

  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!,
    );
  const html = `<!doctype html><meta charset="utf-8"><title>Packshot bake-off</title>
<style>body{font:14px system-ui;margin:24px;background:#f4f4f2}table{border-collapse:collapse}td{vertical-align:top;padding:8px;background:#fff;border:1px solid #ddd}
img{width:260px;height:260px;object-fit:contain;background:#fff;display:block}small{color:#666;display:block;max-width:260px}h1{font-size:18px}</style>
<h1>Packshot bake-off — prompt ${PACKSHOT_PROMPT_VERSION} — jami $${total.toFixed(3)}</h1>
<table>${rows
    .map(
      (r) =>
        `<tr><td><b>${esc(r.name)}</b><img src="${r.original}"><small>${esc(r.description)}</small></td>${r.cells
          .map(
            (c) =>
              `<td>${c.file ? `<img src="${c.file}">` : '<div style="width:260px;height:260px;display:grid;place-items:center;color:#b00">rasm yo\'q</div>'}<small><b>${esc(c.label)}</b><br>${(c.ms / 1000).toFixed(1)} s · $${c.costUsd.toFixed(4)}<br>${esc(c.note)}</small></td>`,
          )
          .join('')}</tr>`,
    )
    .join('')}</table>`;
  writeFileSync(join(out, 'index.html'), html);
  console.log(`\nTotal $${total.toFixed(3)} → ${join(out, 'index.html')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Reads one delivery-note photo through a provider and prints what came back.
 *
 *   AI_API_KEY=... pnpm ai:try-invoice ./nakladnoy.jpg
 *   AI_API_KEY=... AI_PROVIDER=gemini AI_MODEL=gemini-3.5-flash \
 *     pnpm ai:try-invoice ./nakladnoy.jpg
 *
 * Exists to answer the only question that matters before this feature ships:
 * how accurately does a given model read a REAL Uzbek delivery note — creased,
 * stamped, half-Cyrillic, photographed at an angle. Unit tests cannot answer
 * that and neither can a staging deploy.
 *
 * Deliberately talks to the provider adapter directly: no server, no database,
 * no auth, no BYOK key store. Point it at a file and a key and it prints the
 * transcription, the arithmetic check, and what the call cost.
 *
 * Product matching is NOT exercised here — it needs a shop's catalogue, and it
 * is already covered by invoice-match.spec.ts.
 */
import {readFileSync} from 'node:fs';
import {extname} from 'node:path';
import {
  INVOICE_INSTRUCTION,
  INVOICE_SCHEMA,
  INVOICE_SCHEMA_NAME,
  INVOICE_SYSTEM_PROMPT,
  RawInvoice,
} from '../src/ai/invoice/invoice-schema';
import {createProvider} from '../src/ai/providers/provider.factory';
import {
  AiProviderId,
  defaultModelFor,
  estimateCostUsd,
} from '../src/ai/providers/llm-provider.interface';

const MIMES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    throw new Error('Usage: pnpm ai:try-invoice <path-to-image-or-pdf>');
  }

  const apiKey =
    process.env.AI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Set AI_API_KEY (or GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY)');
  }

  const provider = (process.env.AI_PROVIDER ?? 'gemini') as AiProviderId;
  const model = process.env.AI_MODEL ?? defaultModelFor(provider);
  const mimeType = MIMES[extname(path).toLowerCase()];
  if (!mimeType) {
    throw new Error(`Unsupported file type: ${extname(path) || path}`);
  }

  const bytes = readFileSync(path);
  console.log(
    `${provider} / ${model} — ${path} (${(bytes.length / 1024).toFixed(0)} KB)\n`,
  );

  const startedAt = Date.now();
  const result = await createProvider(provider, apiKey, model).extractDocument({
    system: INVOICE_SYSTEM_PROMPT,
    instruction: INVOICE_INSTRUCTION,
    documents: [{mimeType, data: bytes.toString('base64')}],
    schema: INVOICE_SCHEMA,
    schemaName: INVOICE_SCHEMA_NAME,
    signal: AbortSignal.timeout(120_000),
  });
  const elapsed = Date.now() - startedAt;

  const invoice = result.data as RawInvoice;
  console.log(
    [
      `Supplier : ${invoice.supplierName || '—'}`,
      `Document : ${invoice.documentNumber || '—'}  ${invoice.documentDate || ''}`,
      `Currency : ${invoice.currency || '—'}`,
      `Total    : ${fmt(invoice.totalAmount)}`,
      '',
    ].join('\n'),
  );

  const lines = invoice.lines ?? [];
  let summed = 0;
  for (const [i, line] of lines.entries()) {
    const rowTotal = line.lineTotal || line.quantity * line.priceIn;
    summed += rowTotal;
    // The arithmetic check is the whole point of asking for lineTotal as well
    // as quantity and price: a misread digit shows up here and nowhere else.
    const drift =
      line.lineTotal > 0
        ? Math.abs(line.quantity * line.priceIn - line.lineTotal)
        : 0;
    const flag = line.lineTotal > 0 ? (drift <= 1 ? 'ok ' : 'BAD') : ' ? ';
    console.log(
      `${flag} ${String(i + 1).padStart(3)}. ${line.name}` +
        `\n         ${line.quantity} ${line.unit || ''} x ${fmt(line.priceIn)} = ${fmt(line.lineTotal)}` +
        (line.barcode ? `   [${line.barcode}]` : ''),
    );
  }

  const {inputTokens, outputTokens} = result.usage;
  console.log(
    [
      '',
      `Lines    : ${lines.length}`,
      `Row sum  : ${fmt(summed)}` +
        (invoice.totalAmount > 0
          ? Math.abs(summed - invoice.totalAmount) <= 1
            ? '  (matches the printed total)'
            : `  ≠ printed ${fmt(invoice.totalAmount)}  ← something was misread`
          : ''),
      `Tokens   : ${inputTokens} in / ${outputTokens} out`,
      `Cost     : $${estimateCostUsd(model, provider, inputTokens, outputTokens).toFixed(4)}`,
      `Time     : ${(elapsed / 1000).toFixed(1)}s`,
    ].join('\n'),
  );
}

function fmt(value: number): string {
  return value ? new Intl.NumberFormat('uz-UZ').format(value) : '—';
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});

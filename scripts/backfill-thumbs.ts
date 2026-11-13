/**
 * One-off: give every product / shared-barcode picture already in S3 its small
 * copy (`<key>.t320.webp`, RASM-THUMB.md). New uploads make it themselves.
 *
 *   pnpm thumbs:backfill --dry-run          # count what is missing, write nothing
 *   pnpm thumbs:backfill --limit 200        # do the first 200 missing
 *   pnpm thumbs:backfill                    # all of them
 *
 * Reads DATABASE_URL and the S3 env like the app. Idempotent: a picture that
 * already has its small copy is skipped, so it can be stopped and re-run.
 * Pictures on someone else's host are skipped — clients show those as they are.
 */
import 'dotenv/config';
import postgres from 'postgres';
import {StorageService} from '../src/storage/storage.service';
import {thumbKey} from '../src/storage/thumbnail';

const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const CONCURRENCY = 4;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limit = Number(arg('--limit')) || Infinity;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const storage = new StorageService();
  if (!storage.isEnabled()) throw new Error('S3 is not configured');
  const sql = postgres(url, {max: 2});

  const rows = await sql<{image: string}[]>`
    SELECT DISTINCT image FROM (
      SELECT image FROM products WHERE coalesce(image, '') <> ''
      UNION
      SELECT image FROM global_barcodes WHERE coalesce(image, '') <> ''
    ) t`;
  const keys = rows
    .map((r) => storage.keyFromUrl(r.image))
    .filter((k): k is string => !!k);
  console.log(`${rows.length} distinct pictures, ${keys.length} in our bucket`);

  let checked = 0;
  let missing = 0;
  let made = 0;
  let failed = 0;
  const queue = [...keys];

  async function worker(): Promise<void> {
    for (;;) {
      if (made + (dryRun ? missing : 0) >= limit) return;
      const key = queue.shift();
      if (!key) return;
      checked++;
      if (await storage.exists(thumbKey(key))) continue;
      missing++;
      if (dryRun) continue;
      const object = await storage.download(key, MAX_SOURCE_BYTES);
      if (!object) {
        failed++;
        continue;
      }
      await storage.uploadThumb(key, object.data);
      if (await storage.exists(thumbKey(key))) made++;
      else failed++;
      if (made % 50 === 0 && made > 0) console.log(`… ${made} made`);
    }
  }

  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  console.log(
    dryRun
      ? `dry run: ${checked} checked, ${missing} missing a small copy`
      : `${checked} checked, ${missing} missing, ${made} made, ${failed} failed`,
  );
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

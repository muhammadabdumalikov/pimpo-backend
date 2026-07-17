import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';
import * as postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';

import * as schema from './schema';
import { mxikClassifier, type NewMxikClassifier } from './schema';

dotenv.config();

/**
 * Imports the Uzbekistan national product classifier (IKPU / MXIK) from the
 * tasnif.soliq.uz Excel export into the `mxik_classifier` table.
 *
 * Run with:  npm run db:import-mxik [path/to/classifier.xlsx]
 * Default path: ~/Downloads/classifier.xlsx
 *
 * Idempotent: upserts by MXIK code, so re-running refreshes existing rows
 * instead of duplicating them.
 *
 * The sheet has a two-row header. Columns (0-based), Uzbek Cyrillic labels:
 *   0  ГУРУҲ НОМИ      group name (18 top-level categories)
 *   1  СИНФ НОМИ       class name
 *   2  ПОЗИЦИЯ НОМИ    position name
 *   3  СУБПОЗИЦИЯ НОМИ subposition name
 *   4  БРЕНД НОМИ      brand name
 *   5  АТРИБУТ НОМИ    attribute name
 *   6  МХИК КОДИ       17-digit MXIK/IKPU code   -> mxikCode (primary key)
 *   7  МХИК НОМИ       full product name         -> name
 *   8  ШТРИХ КОДИ      barcode (EAN/UPC)         -> barcode
 *   9  ЎЛЧОВ ГУРУҲИ    measure group / package   -> unitName
 *  10  ЎЛЧОВ БИРЛИГИ   measure unit
 *  ...
 */

const BATCH_SIZE = 1000;

// Column indexes in the sheet (see header map above).
const COL = {
  group: 0,
  brand: 4,
  mxik: 6,
  name: 7,
  barcode: 8,
  unitGroupStrict: 9,
  unitStrict: 10,
  unitGroupRecommended: 12,
  unitRecommended: 13,
} as const;

function clean(value: unknown, maxLen: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || s === '---') return null;
  return s.slice(0, maxLen);
}

// The brand column holds the raw classifier line, e.g.
// "00201001001001-Promeat" — keep only the human-readable brand after the code.
function cleanBrand(value: unknown): string | null {
  const s = clean(value, 300);
  if (!s) return null;
  const dash = s.indexOf('-');
  const brand = dash >= 0 ? s.slice(dash + 1).trim() : s;
  return brand && brand !== '---' ? brand.slice(0, 255) : null;
}

// The group column is prefixed with its code, e.g.
// "002-ГЎШТ ВА ГЎШТЛИ..." — strip the leading "NNN-".
function cleanGroup(value: unknown): string | null {
  const s = clean(value, 300);
  if (!s) return null;
  const stripped = s.replace(/^\d+\s*-\s*/, '').trim();
  return (stripped || s).slice(0, 255);
}

async function main() {
  const filePath =
    process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'classifier.xlsx');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  console.log(`Reading ${filePath} ...`);
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: false,
  });

  // Skip the two header rows.
  const dataRows = rows.slice(2);
  console.log(`Parsed ${dataRows.length} data rows.`);

  // De-dupe by MXIK code within the file (keep the last occurrence), so the
  // batch upsert never hits "cannot affect row a second time" from Postgres.
  const byCode = new Map<string, NewMxikClassifier>();
  let skipped = 0;
  for (const row of dataRows) {
    const mxikCode = clean(row[COL.mxik], 17);
    const name = clean(row[COL.name], 500);
    if (!mxikCode || !name) {
      skipped++;
      continue;
    }
    byCode.set(mxikCode, {
      mxikCode,
      name,
      barcode: clean(row[COL.barcode], 20),
      groupName: cleanGroup(row[COL.group]),
      brand: cleanBrand(row[COL.brand]),
      unitName:
        clean(row[COL.unitStrict], 255) ??
        clean(row[COL.unitGroupStrict], 255) ??
        clean(row[COL.unitRecommended], 255) ??
        clean(row[COL.unitGroupRecommended], 255),
    });
  }

  const records = [...byCode.values()];
  console.log(
    `Prepared ${records.length} unique rows ` +
      `(${skipped} skipped for missing code/name).`,
  );

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      await db
        .insert(mxikClassifier)
        .values(batch)
        .onConflictDoUpdate({
          target: mxikClassifier.mxikCode,
          set: {
            name: sql`excluded.name`,
            barcode: sql`excluded.barcode`,
            groupName: sql`excluded.group_name`,
            brand: sql`excluded.brand`,
            unitName: sql`excluded.unit_name`,
            updatedAt: sql`now()`,
          },
        });
      inserted += batch.length;
      if (inserted % 10000 < BATCH_SIZE) {
        console.log(`  ...${inserted}/${records.length}`);
      }
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mxikClassifier);
    console.log(`Done. mxik_classifier now holds ${count} rows.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

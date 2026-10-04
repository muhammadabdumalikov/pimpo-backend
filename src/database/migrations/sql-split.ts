// Statement splitting for the migration runner (see ../migrate.ts).
//
// Most migration files run whole, as one transaction. A file that builds an
// index CONCURRENTLY can't — Postgres refuses that inside a transaction block —
// so it runs one statement at a time, like `psql -f` did. Splitting on ';' is
// only safe outside string literals, quoted identifiers, comments and
// dollar-quoted bodies (every `DO $$ … $$` block is full of semicolons), so
// this scans the text with exactly those states.

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/;

interface Scan {
  /** The text with every comment blanked out. */
  code: string;
  /** Each statement, without its ';', comments kept; comment-only ones dropped. */
  statements: string[];
}

function scan(text: string): Scan {
  const statements: string[] = [];
  let code = '';
  let current = '';
  let hasSql = false; // whether `current` holds anything but comments/space
  const n = text.length;
  let i = 0;

  const take = (j: number, isSql: boolean) => {
    const piece = text.slice(i, j);
    current += piece;
    code += isSql ? piece : ' '.repeat(piece.length);
    if (isSql && piece.trim()) hasSql = true;
    i = j;
  };
  const flush = () => {
    if (hasSql) statements.push(current.trim());
    current = '';
    hasSql = false;
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      take(end === -1 ? n : end, false);
      continue;
    }
    if (ch === '/' && next === '*') {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      take(j, false);
      continue;
    }
    if (ch === "'" || ch === '"') {
      // A doubled quote inside the literal is an escaped quote, not its end;
      // an E'...' string may also backslash-escape it.
      const escapes = ch === "'" && /[eE]/.test(text[i - 1] ?? '');
      let j = i + 1;
      while (j < n) {
        if (escapes && text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      take(Math.min(j, n), true);
      continue;
    }
    if (ch === '$') {
      // `$1` (a parameter) never matches: a tag can't start with a digit.
      const tag = DOLLAR_TAG.exec(text.slice(i))?.[0];
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        take(close === -1 ? n : close + tag.length, true);
        continue;
      }
    }
    if (ch === ';') {
      code += ch;
      i++;
      flush();
      continue;
    }
    take(i + 1, true);
  }
  flush();
  return {code, statements};
}

/** The file's statements, in order, each without its trailing ';'. */
export function splitSqlStatements(text: string): string[] {
  return scan(text).statements;
}

/** Marker a file can carry to opt out of the single transaction explicitly. */
export const NO_TRANSACTION_MARKER = '-- migrate:no-transaction';

/**
 * Whether a file must run statement by statement instead of as one
 * transaction: it says so, or its SQL (not its comments — several explain
 * CONCURRENTLY in prose) builds an index concurrently.
 */
export function needsNoTransaction(text: string): boolean {
  if (text.includes(NO_TRANSACTION_MARKER)) return true;
  return /\bconcurrently\b/i.test(scan(text).code);
}

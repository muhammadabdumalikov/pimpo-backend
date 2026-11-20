/**
 * Pure helpers that turn shipped commits into Telegram HTML messages for the
 * team's deploy channel. No I/O here, so the splitting is unit-tested.
 */

/** Telegram refuses a message over 4096 characters; keep headroom. */
export const MESSAGE_LIMIT = 4000;
/** More than this in one deploy and the rest is a "Yana N ta" link. */
export const MAX_COMMITS = 40;

export interface ShippedCommit {
  sha: string;
  /** Full commit message as written (English). */
  message: string;
  url: string;
}

/** One commit as shown: the Uzbek title + body (or the original on fallback). */
export interface NoticeItem {
  sha: string;
  url: string;
  title: string;
  body: string;
}

const TRAILER = /^(Co-Authored-By|Signed-off-by):.*$/gim;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A commit message without its Co-Authored-By / Signed-off-by trailers. */
export function cleanMessage(message: string): string {
  return message.replace(TRAILER, '').trim();
}

/** Subject + body of a commit message, trailers dropped. */
export function splitMessage(message: string): {title: string; body: string} {
  const clean = cleanMessage(message);
  const nl = clean.indexOf('\n');
  if (nl < 0) return {title: clean, body: ''};
  return {title: clean.slice(0, nl).trim(), body: clean.slice(nl + 1).trim()};
}

function renderItem(item: NoticeItem, body: string): string {
  const parts = [`<b>${escapeHtml(item.title)}</b>`];
  if (body) parts.push(escapeHtml(body));
  parts.push(
    `<a href="${escapeHtml(item.url).replace(/"/g, '&quot;')}">${escapeHtml(item.sha.slice(0, 7))}</a>`,
  );
  return parts.join('\n');
}

/**
 * One commit's block, cut to `budget` characters. The raw body is trimmed, never
 * the escaped text, so an `&amp;` is not split in half.
 */
export function renderBlock(item: NoticeItem, budget: number): string {
  const full = renderItem(item, item.body);
  if (full.length <= budget) return full;
  // Longest raw prefix that still fits once escaped; escaping grows unevenly
  // (& is five characters), so search rather than subtract.
  const cut = (n: number) => {
    const body = item.body.slice(0, n).trimEnd();
    return renderItem(item, body ? `${body}…` : '');
  };
  let lo = 0;
  let hi = item.body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cut(mid).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

/** Header, blocks and footer packed into as few messages as fit the limit. */
export function packMessages(
  header: string,
  blocks: string[],
  footer?: string,
): string[] {
  const messages: string[] = [];
  let current = header;
  for (const part of footer ? [...blocks, footer] : blocks) {
    if (current.length + 2 + part.length > MESSAGE_LIMIT) {
      messages.push(current);
      current = part;
    } else {
      current += `\n\n${part}`;
    }
  }
  messages.push(current);
  return messages;
}

export function buildNotice(opts: {
  label: string;
  items: NoticeItem[];
  total: number;
  compareUrl?: string;
  /** True when the AI translation failed and the English original is shown. */
  untranslated?: boolean;
}): string[] {
  const {label, items, total, compareUrl, untranslated} = opts;
  let header = `🚀 <b>${escapeHtml(label)}</b> · ${total} ta o'zgarish`;
  if (untranslated) header += `\n<i>Tarjima ishlamadi, asl matn yuborildi.</i>`;
  const blocks = items.map((i) => renderBlock(i, MESSAGE_LIMIT - 200));
  let footer: string | undefined;
  if (compareUrl) {
    const more =
      total > items.length ? `Yana ${total - items.length} ta · ` : '';
    footer = `${more}<a href="${escapeHtml(compareUrl).replace(/"/g, '&quot;')}">GitHub'da hammasi</a>`;
  }
  return packMessages(header, blocks, footer);
}

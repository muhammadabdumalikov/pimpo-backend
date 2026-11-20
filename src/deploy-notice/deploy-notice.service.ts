import {Injectable, Logger, OnApplicationBootstrap} from '@nestjs/common';
import {GoogleGenAI} from '@google/genai';
import {sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {TelegramSenderService} from '../telegram/telegram-sender.service';
import {
  buildNotice,
  cleanMessage,
  MAX_COMMITS,
  NoticeItem,
  ShippedCommit,
  splitMessage,
} from './deploy-notice.format';

const DEFAULT_REPO = 'muhammadabdumalikov/pimpo-backend';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
/** Wait for the new server to be listening (and healthy) before announcing. */
const BOOT_DELAY_MS = 30_000;

const TRANSLATE_SYSTEM = `You translate git commit messages of KPOS — a point-of-sale and shop management app for stores in Uzbekistan — into Uzbek (Latin script) for the KPOS team's Telegram deploy channel.

Rules:
- This is a detailed changelog, not a summary: keep every fact, number and condition.
- Keep code identifiers exactly as written: endpoints (POST /shifts/:id/approve), permission keys (shift:approve), error codes, table/column/env/file names, migration numbers (0123).
- Plain, natural Uzbek. Use these words: mahsulot (never "tovar"), yaroqsiz (never "brak"), buyurtma (never "zakaz"), oldindan to'lov (never "zaklad"), sotuvdagi qoldiq (never "javon"). Uzbek UI words already in the text (kirim, chiqim, Tuzatish, nasiya, nakladnoy, smena, filial) stay as they are.
- Team jargon stays in English: deploy, commit, push, build, workflow, endpoint, secret, cache.
- Use the ' apostrophe: o', g'.
- Lines that start with "- " start with "• " instead.

Input: a JSON array of {"sha", "message"}.
Output: only a JSON array of {"sha", "title", "body"} — same order, one item per input commit. "title" is the first line, "body" the rest ("" when there is none).`;

/**
 * Posts what each deploy shipped, in Uzbek, to the team's Telegram channel
 * (TELEGRAM_DEPLOY_CHAT_ID, via the platform bot).
 *
 * - Backend: Coolify deploys by hand, so the running server announces itself.
 *   On boot it compares SOURCE_COMMIT with the last announced commit
 *   (ops.deploy_notices); a new one gets the commits in between from GitHub.
 * - Dashboard: its GitHub Actions deploy posts the commits to
 *   POST /platform/deploy-notice, which lands in {@link announce}.
 *
 * Every failure is logged and swallowed: a notice must never break a boot.
 */
@Injectable()
export class DeployNoticeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeployNoticeService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly telegram: TelegramSenderService,
  ) {}

  private get chatId(): string | undefined {
    return process.env.TELEGRAM_DEPLOY_CHAT_ID?.trim() || undefined;
  }

  onApplicationBootstrap() {
    // Unset chat = local dev or not wanted; no DB work, no GitHub calls.
    if (!this.chatId) return;
    setTimeout(() => {
      this.announceOwnDeploy().catch((err) =>
        this.logger.warn(`Backend deploy notice failed: ${err}`),
      );
    }, BOOT_DELAY_MS).unref();
  }

  async announceOwnDeploy(): Promise<void> {
    const head = process.env.SOURCE_COMMIT?.trim().toLowerCase();
    if (!head || !/^[0-9a-f]{7,40}$/.test(head)) {
      this.logger.warn(
        'SOURCE_COMMIT is not set; enable "Include Source Commit in Build" in Coolify. Deploy notice skipped.',
      );
      return;
    }
    const repo = process.env.DEPLOY_NOTICE_REPO?.trim() || DEFAULT_REPO;
    const claim = await this.claim(repo, head);
    if (!claim.isNew) return; // a restart of what was already announced

    const web = `https://github.com/${repo}`;
    const label = 'Backend (pimpo-backend)';
    if (!claim.previous) {
      const c = await this.github<GhCommit>(`/repos/${repo}/commits/${head}`);
      await this.announce({label, commits: [toShipped(c, web)], total: 1});
      return;
    }
    const cmp = await this.github<GhCompare>(
      `/repos/${repo}/compare/${claim.previous}...${head}`,
    );
    if (cmp.status === 'behind') {
      await this.send([
        `↩️ <b>${label}</b> orqaga qaytarildi: <a href="${web}/commit/${head}">${head.slice(0, 7)}</a>`,
      ]);
      return;
    }
    const commits = cmp.commits
      .filter((c) => c.parents.length < 2) // merges say nothing new
      .slice(-MAX_COMMITS)
      .map((c) => toShipped(c, web));
    if (!commits.length) return;
    await this.announce({
      label,
      commits,
      total: cmp.total_commits,
      compareUrl: `${web}/compare/${claim.previous.slice(0, 12)}...${head.slice(0, 12)}`,
    });
  }

  /** Translate to Uzbek and post. Falls back to the English original. */
  async announce(opts: {
    label: string;
    commits: ShippedCommit[];
    total: number;
    compareUrl?: string;
  }): Promise<void> {
    if (!this.chatId || !opts.commits.length) return;
    const commits = opts.commits.slice(-MAX_COMMITS);
    let items = await this.translate(commits).catch((err) => {
      this.logger.warn(`Deploy notice translation failed: ${err}`);
      return null;
    });
    const untranslated = !items;
    items ??= commits.map((c) => ({
      sha: c.sha,
      url: c.url,
      ...splitMessage(c.message),
    }));
    await this.send(
      buildNotice({
        label: opts.label,
        items,
        total: Math.max(opts.total, commits.length),
        compareUrl: opts.compareUrl,
        untranslated,
      }),
    );
  }

  private async send(messages: string[]): Promise<void> {
    for (const text of messages) {
      await this.telegram.sendMessage(
        this.chatId!,
        text,
        undefined,
        undefined,
        {
          html: true,
        },
      );
    }
  }

  private async translate(commits: ShippedCommit[]): Promise<NoticeItem[]> {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    const ai = new GoogleGenAI({apiKey});
    const input = commits.map((c) => ({
      sha: c.sha,
      message: cleanMessage(c.message),
    }));
    const res = await ai.models.generateContent({
      model: process.env.DEPLOY_NOTICE_MODEL?.trim() || DEFAULT_MODEL,
      contents: [{role: 'user', parts: [{text: JSON.stringify(input)}]}],
      config: {
        systemInstruction: TRANSLATE_SYSTEM,
        responseMimeType: 'application/json',
        // 40 detailed commits run to ~10k tokens; on the Gemini 3 line the
        // budget is shared with thinking, and a tight one comes back empty.
        maxOutputTokens: 32_000,
        abortSignal: AbortSignal.timeout(90_000),
      },
    });
    type Row = {sha?: unknown; title?: unknown; body?: unknown} | undefined;
    const parsed = JSON.parse(res.text ?? '') as unknown;
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    const rows = parsed as Row[];
    const bySha = new Map<string, Row>();
    for (const row of rows) {
      if (typeof row?.sha === 'string') bySha.set(row.sha, row);
    }
    return commits.map((c, i) => {
      // Match by sha; position is the fallback when the model shortens it.
      const row = bySha.get(c.sha) ?? rows[i];
      if (typeof row?.title !== 'string' || !row.title.trim()) {
        throw new Error(`no title for ${c.sha.slice(0, 7)}`);
      }
      return {
        sha: c.sha,
        url: c.url,
        title: row.title.trim(),
        body: typeof row.body === 'string' ? row.body.trim() : '',
      };
    });
  }

  /**
   * Record `head` as announced. isNew is false when it already was (a
   * restart, or a second container of the same deploy), so exactly one
   * process announces it. ops is the same schema migrate.ts keeps its
   * bookkeeping in.
   */
  private async claim(
    repo: string,
    head: string,
  ): Promise<{isNew: boolean; previous: string | null}> {
    const db = this.database.db;
    // One statement per execute: postgres-js prepares them, and a prepared
    // statement cannot hold two.
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ops`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ops.deploy_notices (
        repo text PRIMARY KEY,
        sha text NOT NULL,
        announced_at timestamptz NOT NULL DEFAULT now()
      )`);
    const rows = (await db.execute(sql`
      WITH prev AS (SELECT sha FROM ops.deploy_notices WHERE repo = ${repo})
      INSERT INTO ops.deploy_notices (repo, sha) VALUES (${repo}, ${head})
      ON CONFLICT (repo) DO UPDATE
        SET sha = EXCLUDED.sha, announced_at = now()
        WHERE ops.deploy_notices.sha <> EXCLUDED.sha
      RETURNING (SELECT sha FROM prev) AS previous`)) as unknown as {
      previous: string | null;
    }[];
    if (!rows.length) return {isNew: false, previous: null};
    return {isNew: true, previous: rows[0].previous ?? null};
  }

  private async github<T>(path: string): Promise<T> {
    const token = process.env.GITHUB_TOKEN?.trim();
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'kpos-deploy-notice',
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

interface GhCommit {
  sha: string;
  parents: {sha: string}[];
  commit: {message: string};
}

interface GhCompare {
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  total_commits: number;
  commits: GhCommit[];
}

function toShipped(c: GhCommit, web: string): ShippedCommit {
  return {sha: c.sha, message: c.commit.message, url: `${web}/commit/${c.sha}`};
}

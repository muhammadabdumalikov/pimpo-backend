import {Injectable, Logger} from '@nestjs/common';
import {and, asc, desc, eq, gte, isNotNull, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  aiAssistantFaqs,
  aiAssistantSettings,
  businesses,
  customerChatHandoffs,
  customerChatMessages,
  customerChats,
  type AiAssistantSettings,
  type CustomerChat,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {FeatureService} from '../feature/feature.service';
import {SubscriptionService} from '../subscription/subscription.service';
import {tierAtLeast} from '../subscription/tier';
import {createProvider} from '../ai/providers/provider.factory';
import {
  AI_PROVIDER_IDS,
  defaultModelFor,
  type AiProviderId,
  type LlmTurn,
} from '../ai/providers/llm-provider.interface';
import type {TgMessage, TgUpdate} from '../telegram/telegram-update-hooks';
import {
  AssistantToolsService,
  CUSTOMER_TOOLS,
  type ToolOutcome,
} from './assistant-tools';
import {buildAssistantPrompt} from './assistant-prompt';
import {AssistantHandoffService} from './assistant-handoff.service';
import {AssistantTelegram, type InlineButton} from './assistant-telegram';
import {detectLocale, t, type ChatLocale} from './assistant-text';
import {SHOP_TIME_ZONE} from '../branch/working-hours';

/** Q13: AI answers per customer per hour. */
const PER_CUSTOMER_HOURLY = 20;
/** Q11: AI answers per shop per month (env-tunable until the price is set). */
const monthlyLimit = () => Number(process.env.AI_ASSISTANT_MONTHLY_LIMIT) || 2000;
const HISTORY_MESSAGES = 20;
const MAX_ITERATIONS = 5;
const RUN_TIMEOUT_MS = 45_000;

export interface ModelAnswer {
  text: string;
  outcome: ToolOutcome;
  toolCalls: {name: string; args: Record<string, unknown>; ok: boolean; ms: number}[];
  model: string;
  tokensIn: number;
  tokensOut: number;
  failed: boolean;
}

/**
 * The customer assistant pipeline (AI-YORDAMCHI.md §2): one Telegram message
 * to the shop's bot in, at most one answer (or a handoff) out.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  /** One message at a time per chat, so answers never cross. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly dbService: DatabaseService,
    private readonly tools: AssistantToolsService,
    private readonly handoff: AssistantHandoffService,
    private readonly tg: AssistantTelegram,
    private readonly features: FeatureService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** Webhook entry: returns at once, the work runs serialised per chat. */
  enqueue(businessId: string, update: TgUpdate): void {
    const msg = update.message;
    if (!msg || msg.chat.type !== 'private' || msg.from?.is_bot) return;
    const key = `${businessId}:${msg.chat.id}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.handle(businessId, msg))
      .catch((e) => this.logger.error(`assistant ${key}: ${(e as Error).message}`))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  /** Flag on, assistant switched on, Business plan — else the bot stays silent. */
  async activeSettings(businessId: string): Promise<AiAssistantSettings | null> {
    const [settings] = await this.db
      .select()
      .from(aiAssistantSettings)
      .where(eq(aiAssistantSettings.businessId, businessId))
      .limit(1);
    if (!settings?.enabled) return null;
    if (!(await this.features.isEnabled(businessId, 'ai_assistant'))) return null;
    const tier = await this.subscriptions.getEffectiveTier(businessId);
    if (!tierAtLeast(tier, 'pro')) return null;
    return settings;
  }

  private async handle(businessId: string, msg: TgMessage): Promise<void> {
    const settings = await this.activeSettings(businessId);
    if (!settings) return;
    const token = await this.handoff.storeToken(businessId);
    if (!token) return;

    const chat = await this.upsertChat(businessId, msg);
    const text = (msg.text ?? msg.caption ?? '').trim() || null;
    const photoFileId =
      msg.photo?.[msg.photo.length - 1]?.file_id ?? msg.document?.file_id ?? null;
    const hasMedia = !!(photoFileId || msg.video || msg.voice);

    if (text === '/start' || text?.startsWith('/start ')) {
      const shop = await this.shopName(businessId);
      const locale: ChatLocale = msg.from?.language_code === 'ru' ? 'ru' : 'uz';
      const greeting = settings.greeting?.trim() || t(locale, 'greeting', {shop});
      await this.handoff.sendToCustomer(chat, token, greeting, 'bot');
      return;
    }
    if (!text && !hasMedia) return; // stickers, contacts, … — nothing to answer

    await this.db.insert(customerChatMessages).values({
      id: generateId(),
      businessId,
      chatId: chat.id,
      role: 'customer',
      text,
      media: photoFileId
        ? {kind: msg.photo ? 'photo' : 'document', fileId: photoFileId}
        : msg.video
          ? {kind: 'video', fileId: msg.video.file_id}
          : msg.voice
            ? {kind: 'voice', fileId: msg.voice.file_id}
            : null,
    });

    const locale = detectLocale(text) ;

    // Q18: a person is handling this chat.
    if (chat.humanUntil && chat.humanUntil > new Date()) {
      await this.handoff.forwardToHuman(businessId, chat, token, text, photoFileId);
      return;
    }

    // Q9: pictures (and voice/video) always go to a person.
    if (hasMedia) {
      await this.handoff.create({
        businessId, chat, storeToken: token, reason: 'photo',
        summary: text, locale: text ? locale : await this.handoff.chatLocale(chat.id),
        photoFileId,
      });
      return;
    }

    // Q13: per-customer hourly cap, Q11: monthly allowance.
    const limitReason =
      (await this.aiAnswersSince(chat.id, null, 60 * 60 * 1000)) >= PER_CUSTOMER_HOURLY
        ? 'rate_limit'
        : (await this.aiAnswersThisMonth(businessId)) >= monthlyLimit()
          ? 'quota'
          : null;
    if (limitReason) {
      if (await this.hasOpenHandoff(chat.id, limitReason)) {
        await this.handoff.forwardToHuman(businessId, chat, token, text, null);
      } else {
        await this.handoff.create({
          businessId, chat, storeToken: token, reason: limitReason, summary: text, locale,
        });
      }
      return;
    }

    await this.tg.typing(chat.telegramChatId, token);
    const history = await this.history(chat.id);
    const answer = await this.runModel(businessId, settings, history, text!);

    if (answer.outcome.ignore) {
      await this.saveBotRow(chat, answer, null);
      return;
    }
    if (answer.outcome.handoff || answer.failed || !answer.text.trim()) {
      await this.saveBotRow(chat, answer, null);
      await this.handoff.create({
        businessId,
        chat,
        storeToken: token,
        reason: answer.outcome.handoff?.reason ?? 'unknown',
        summary: answer.outcome.handoff?.summary ?? text,
        locale,
      });
      return;
    }

    const buttons = this.orderButtons(answer.outcome, locale);
    await this.tg.sendMessage(chat.telegramChatId, answer.text.trim(), {token, buttons});
    await this.saveBotRow(chat, answer, answer.text.trim());
  }

  /**
   * One model answer, no Telegram. Also what the settings page's "Sinab
   * ko'rish" window calls, so the owner tests exactly what customers get.
   */
  async runModel(
    businessId: string,
    settings: Pick<AiAssistantSettings, 'tone' | 'policies'>,
    history: LlmTurn[],
    question: string,
  ): Promise<ModelAnswer> {
    const outcome: ToolOutcome = {orderProducts: [], handoff: null, ignore: false};
    const toolCalls: ModelAnswer['toolCalls'] = [];
    const {provider, model, key} = this.providerConfig();
    const empty: ModelAnswer = {
      text: '', outcome, toolCalls, model, tokensIn: 0, tokensOut: 0, failed: true,
    };
    if (!key) {
      this.logger.error(`AI assistant: no API key for provider ${provider}`);
      return empty;
    }

    const storeBaseUrl = await this.tools.storeBaseUrl(businessId);
    const faqs = await this.db
      .select({question: aiAssistantFaqs.question, answer: aiAssistantFaqs.answer})
      .from(aiAssistantFaqs)
      .where(eq(aiAssistantFaqs.businessId, businessId))
      .orderBy(asc(aiAssistantFaqs.createdAt));
    const system = buildAssistantPrompt({
      shopName: await this.shopName(businessId),
      tone: settings.tone === 'friendly' ? 'friendly' : 'formal',
      policies: settings.policies,
      faqs,
      hasOnlineStore: storeBaseUrl !== null,
      now: shopNow(),
      replyLanguage: LANGUAGE_NAME[detectLocale(question)],
    });

    const llm = createProvider(provider, key, model);
    const ctx = {businessId, storeBaseUrl};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    // Text is split at each tool call: models often write a preamble, call a
    // tool, then write the answer (or just "OK") — only one part is the reply.
    const segments: string[] = [''];
    let tokensIn = 0;
    let tokensOut = 0;
    let failed = false;
    try {
      for await (const ev of llm.run({
        system,
        history,
        question,
        tools: CUSTOMER_TOOLS,
        signal: controller.signal,
        maxIterations: MAX_ITERATIONS,
        executeTool: async (name, args) => {
          const started = Date.now();
          let res: {ok: boolean; result: unknown};
          try {
            res = await this.tools.execute(ctx, outcome, name, args);
          } catch (e) {
            res = {ok: false, result: {error: (e as Error).message}};
          }
          toolCalls.push({name, args, ok: res.ok, ms: Date.now() - started});
          return res;
        },
      })) {
        if (ev.type === 'text') segments[segments.length - 1] += ev.delta;
        else if (ev.type === 'tool_start') {
          if (segments[segments.length - 1].trim()) segments.push('');
        } else if (ev.type === 'usage') {
          tokensIn += ev.inputTokens;
          tokensOut += ev.outputTokens;
        } else if (ev.type === 'error') {
          this.logger.warn(`AI assistant model error: ${ev.message}`);
          failed = true;
        }
      }
    } catch (e) {
      this.logger.warn(`AI assistant run failed: ${(e as Error).message}`);
      failed = true;
    } finally {
      clearTimeout(timer);
    }
    return {text: pickReply(segments), outcome, toolCalls, model, tokensIn, tokensOut, failed};
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private providerConfig(): {provider: AiProviderId; model: string; key: string | undefined} {
    const raw = (process.env.AI_ASSISTANT_PROVIDER || 'gemini').trim() as AiProviderId;
    const provider = AI_PROVIDER_IDS.includes(raw) ? raw : 'gemini';
    const model = process.env.AI_ASSISTANT_MODEL?.trim() || defaultModelFor(provider);
    const key = {
      gemini: process.env.GEMINI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    }[provider]?.trim();
    return {provider, model, key};
  }

  private orderButtons(outcome: ToolOutcome, locale: ChatLocale): InlineButton[][] {
    return outcome.orderProducts.map((p) => [
      {
        text: `🛒 ${t(locale, 'orderButton')}: ${p.name}`.slice(0, 60),
        web_app: {url: p.url},
      },
    ]);
  }

  private async saveBotRow(chat: CustomerChat, a: ModelAnswer, text: string | null) {
    await this.db.insert(customerChatMessages).values({
      id: generateId(),
      businessId: chat.businessId,
      chatId: chat.id,
      role: 'bot',
      text,
      toolCalls: a.toolCalls.length ? a.toolCalls : null,
      model: a.model,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
    });
    await this.db
      .update(customerChats)
      .set({lastMessageAt: new Date()})
      .where(eq(customerChats.id, chat.id));
  }

  private async upsertChat(businessId: string, msg: TgMessage): Promise<CustomerChat> {
    const [row] = await this.db
      .insert(customerChats)
      .values({
        id: generateId(),
        businessId,
        telegramChatId: String(msg.chat.id),
        telegramUserId: msg.from ? String(msg.from.id) : null,
        firstName: msg.from?.first_name ?? null,
        username: msg.from?.username ?? null,
      })
      .onConflictDoUpdate({
        target: [customerChats.businessId, customerChats.telegramChatId],
        set: {
          firstName: msg.from?.first_name ?? null,
          username: msg.from?.username ?? null,
          lastMessageAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /** Last messages as model turns; staff lines are marked, empty rows dropped. */
  private async history(chatId: string): Promise<LlmTurn[]> {
    const rows = await this.db
      .select({role: customerChatMessages.role, text: customerChatMessages.text})
      .from(customerChatMessages)
      .where(eq(customerChatMessages.chatId, chatId))
      .orderBy(desc(customerChatMessages.createdAt))
      .limit(HISTORY_MESSAGES + 1);
    // Newest row is the question being asked now — passed separately.
    const ordered = rows.slice(1).reverse();
    const turns: LlmTurn[] = [];
    for (const r of ordered) {
      if (!r.text) continue;
      const role: LlmTurn['role'] = r.role === 'customer' ? 'user' : 'assistant';
      const content = r.role === 'staff' ? `[Operator] ${r.text}` : r.text;
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.content += `\n${content}`;
      else turns.push({role, content});
    }
    while (turns.length && turns[0].role !== 'user') turns.shift();
    // The question that follows is a user turn, so history must end on the bot.
    while (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
    return turns;
  }

  private async aiAnswersSince(chatId: string | null, businessId: string | null, ms: number) {
    const [{n}] = await this.db
      .select({n: sql<number>`count(*)::int`})
      .from(customerChatMessages)
      .where(
        and(
          chatId ? eq(customerChatMessages.chatId, chatId) : undefined,
          businessId ? eq(customerChatMessages.businessId, businessId) : undefined,
          eq(customerChatMessages.role, 'bot'),
          isNotNull(customerChatMessages.model),
          gte(customerChatMessages.createdAt, new Date(Date.now() - ms)),
        ),
      );
    return n;
  }

  async aiAnswersThisMonth(businessId: string): Promise<number> {
    const [{n}] = await this.db
      .select({n: sql<number>`count(*)::int`})
      .from(customerChatMessages)
      .where(
        and(
          eq(customerChatMessages.businessId, businessId),
          eq(customerChatMessages.role, 'bot'),
          isNotNull(customerChatMessages.model),
          sql`${customerChatMessages.createdAt} >= date_trunc('month', now() AT TIME ZONE ${SHOP_TIME_ZONE}) AT TIME ZONE ${SHOP_TIME_ZONE}`,
        ),
      );
    return n;
  }

  monthlyLimit(): number {
    return monthlyLimit();
  }

  private async hasOpenHandoff(chatId: string, reason: string): Promise<boolean> {
    const [row] = await this.db
      .select({id: customerChatHandoffs.id})
      .from(customerChatHandoffs)
      .where(
        and(
          eq(customerChatHandoffs.chatId, chatId),
          eq(customerChatHandoffs.reason, reason),
          sql`${customerChatHandoffs.status} <> 'closed'`,
          gte(customerChatHandoffs.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      )
      .limit(1);
    return !!row;
  }

  private async shopName(businessId: string): Promise<string> {
    const [b] = await this.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return b?.name ?? '';
  }
}

/** "2026-11-11 14:05, Wednesday" on shop time. */
function shopNow(): string {
  const d = new Date();
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
  const day = new Intl.DateTimeFormat('en-US', {timeZone: SHOP_TIME_ZONE, weekday: 'long'}).format(d);
  return `${date}, ${day}`;
}

const LANGUAGE_NAME: Record<ChatLocale, string> = {
  uz: 'Uzbek, Latin script',
  uzc: 'Uzbek, Cyrillic script (ўқғҳ)',
  ru: 'Russian',
};

/** The last substantial text segment; "OK"/"Done" tails fall back to the one before. */
function pickReply(segments: string[]): string {
  const parts = segments.map((s) => stripMarkdown(s)).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].length >= 12 && !/^(ok|okay|done|tayyor)[.!]?$/i.test(parts[i])) {
      return parts[i];
    }
  }
  return parts[parts.length - 1] ?? '';
}

/** Telegram gets plain text: drop the Markdown models add anyway. */
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

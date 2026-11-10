import {Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {and, asc, eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  aiAssistantFaqs,
  aiAssistantSettings,
  storeBots,
  type AiAssistantSettings,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {TelegramUpdateHooks} from '../telegram/telegram-update-hooks';
import {AssistantTelegram} from './assistant-telegram';
import {AssistantService} from './assistant.service';
import {AssistantToolsService} from './assistant-tools';
import type {LlmTurn} from '../ai/providers/llm-provider.interface';

export interface AssistantSettingsPatch {
  enabled?: boolean;
  tone?: 'formal' | 'friendly';
  greeting?: string | null;
  policies?: string | null;
  shareWithPlatform?: boolean;
}

const DEFAULTS: Omit<AiAssistantSettings, 'businessId' | 'updatedAt'> = {
  enabled: false,
  tone: 'formal',
  greeting: null,
  policies: null,
  shareWithPlatform: false,
};

/** The "AI yordamchi" settings page (AI-YORDAMCHI.md Q8) and its webhook. */
@Injectable()
export class AssistantSettingsService implements OnModuleInit {
  private readonly logger = new Logger(AssistantSettingsService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly tg: AssistantTelegram,
    private readonly assistant: AssistantService,
    private readonly tools: AssistantToolsService,
    private readonly hooks: TelegramUpdateHooks,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  onModuleInit(): void {
    this.hooks.onStoreBotChanged((businessId, token, previous) =>
      this.onStoreBotChanged(businessId, token, previous),
    );
  }

  async get(businessId: string) {
    const [row] = await this.db
      .select()
      .from(aiAssistantSettings)
      .where(eq(aiAssistantSettings.businessId, businessId))
      .limit(1);
    const [bot] = await this.db
      .select({username: storeBots.botUsername})
      .from(storeBots)
      .where(eq(storeBots.businessId, businessId))
      .limit(1);
    const faqs = await this.listFaqs(businessId);
    return {
      settings: {
        enabled: row?.enabled ?? DEFAULTS.enabled,
        tone: (row?.tone ?? DEFAULTS.tone) as 'formal' | 'friendly',
        greeting: row?.greeting ?? null,
        policies: row?.policies ?? null,
        shareWithPlatform: row?.shareWithPlatform ?? false,
      },
      faqs,
      status: {
        storeBotConnected: !!bot,
        botUsername: bot?.username ?? null,
        botLink: bot?.username ? `https://t.me/${bot.username}` : null,
        hasOnlineStore: (await this.tools.storeBaseUrl(businessId)) !== null,
        usage: {
          thisMonth: await this.assistant.aiAnswersThisMonth(businessId),
          limit: this.assistant.monthlyLimit(),
        },
      },
    };
  }

  async update(businessId: string, patch: AssistantSettingsPatch) {
    const [current] = await this.db
      .select()
      .from(aiAssistantSettings)
      .where(eq(aiAssistantSettings.businessId, businessId))
      .limit(1);
    const wasEnabled = current?.enabled ?? false;

    // Switching on points the store bot's webhook at us; switching off
    // removes it. Done before saving so a refused webhook leaves it off.
    if (patch.enabled !== undefined && patch.enabled !== wasEnabled) {
      const token = await this.storeToken(businessId);
      if (patch.enabled) {
        if (!token) throw new AppException(ErrorCode.ASSISTANT_STORE_BOT_REQUIRED);
        if (!AssistantTelegram.webhookUrl(businessId)) {
          throw new AppException(ErrorCode.ASSISTANT_NOT_CONFIGURED);
        }
        try {
          await this.tg.setWebhook(businessId, token);
        } catch (e) {
          this.logger.warn(`setWebhook ${businessId}: ${(e as Error).message}`);
          throw new AppException(ErrorCode.ASSISTANT_WEBHOOK_FAILED);
        }
      } else if (token) {
        await this.tg.deleteWebhook(token).catch((e) =>
          this.logger.warn(`deleteWebhook ${businessId}: ${(e as Error).message}`),
        );
      }
    }

    const values = {
      enabled: patch.enabled ?? current?.enabled ?? DEFAULTS.enabled,
      tone: patch.tone ?? current?.tone ?? DEFAULTS.tone,
      greeting: patch.greeting !== undefined ? patch.greeting?.trim() || null : current?.greeting ?? null,
      policies: patch.policies !== undefined ? patch.policies?.trim() || null : current?.policies ?? null,
      shareWithPlatform: patch.shareWithPlatform ?? current?.shareWithPlatform ?? false,
      updatedAt: new Date(),
    };
    await this.db
      .insert(aiAssistantSettings)
      .values({businessId, ...values})
      .onConflictDoUpdate({target: aiAssistantSettings.businessId, set: values});
    return this.get(businessId);
  }

  // ── FAQ ────────────────────────────────────────────────────────────────────

  listFaqs(businessId: string) {
    return this.db
      .select({
        id: aiAssistantFaqs.id,
        question: aiAssistantFaqs.question,
        answer: aiAssistantFaqs.answer,
        source: aiAssistantFaqs.source,
        createdAt: aiAssistantFaqs.createdAt,
        updatedAt: aiAssistantFaqs.updatedAt,
      })
      .from(aiAssistantFaqs)
      .where(eq(aiAssistantFaqs.businessId, businessId))
      .orderBy(asc(aiAssistantFaqs.createdAt));
  }

  async createFaq(businessId: string, question: string, answer: string) {
    const [row] = await this.db
      .insert(aiAssistantFaqs)
      .values({id: generateId(), businessId, question: question.trim(), answer: answer.trim()})
      .returning();
    return row;
  }

  async updateFaq(businessId: string, id: string, data: {question?: string; answer?: string}) {
    const [row] = await this.db
      .update(aiAssistantFaqs)
      .set({
        ...(data.question !== undefined ? {question: data.question.trim()} : {}),
        ...(data.answer !== undefined ? {answer: data.answer.trim()} : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(aiAssistantFaqs.id, id), eq(aiAssistantFaqs.businessId, businessId)))
      .returning();
    if (!row) throw new AppException(ErrorCode.ASSISTANT_FAQ_NOT_FOUND);
    return row;
  }

  async deleteFaq(businessId: string, id: string) {
    const rows = await this.db
      .delete(aiAssistantFaqs)
      .where(and(eq(aiAssistantFaqs.id, id), eq(aiAssistantFaqs.businessId, businessId)))
      .returning({id: aiAssistantFaqs.id});
    if (!rows.length) throw new AppException(ErrorCode.ASSISTANT_FAQ_NOT_FOUND);
  }

  // ── "Sinab ko'rish" ────────────────────────────────────────────────────────

  /**
   * The same model, prompt and tools customers get, with the settings as they
   * are saved now — but no Telegram, nothing stored and nothing handed over.
   * Counts toward nothing: the owner testing their bot is not a customer.
   */
  async test(businessId: string, history: LlmTurn[], question: string) {
    const {settings} = await this.get(businessId);
    const answer = await this.assistant.runModel(businessId, settings, history, question);
    if (answer.failed && !answer.outcome.handoff) {
      throw new AppException(ErrorCode.ASSISTANT_NOT_CONFIGURED);
    }
    return {
      text: answer.outcome.handoff || answer.outcome.ignore ? '' : answer.text,
      handoff: answer.outcome.handoff,
      ignored: answer.outcome.ignore,
      orderProducts: answer.outcome.orderProducts,
      toolCalls: answer.toolCalls.map((c) => ({name: c.name, ok: c.ok})),
    };
  }

  // ── Store bot replaced / removed ───────────────────────────────────────────

  private async onStoreBotChanged(
    businessId: string,
    token: string | null,
    previous: string | null,
  ): Promise<void> {
    if (previous && previous !== token) {
      await this.tg.deleteWebhook(previous).catch(() => undefined);
    }
    const [row] = await this.db
      .select({enabled: aiAssistantSettings.enabled})
      .from(aiAssistantSettings)
      .where(eq(aiAssistantSettings.businessId, businessId))
      .limit(1);
    if (!row?.enabled) return;
    if (token) {
      await this.tg.setWebhook(businessId, token);
    } else {
      // No bot left to answer through: switch the assistant off.
      await this.db
        .update(aiAssistantSettings)
        .set({enabled: false, updatedAt: new Date()})
        .where(eq(aiAssistantSettings.businessId, businessId));
    }
  }

  private async storeToken(businessId: string): Promise<string | null> {
    const [row] = await this.db
      .select({token: storeBots.botToken})
      .from(storeBots)
      .where(eq(storeBots.businessId, businessId))
      .limit(1);
    return row?.token ?? null;
  }
}

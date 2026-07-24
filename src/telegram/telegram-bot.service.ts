import {Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {AuthService} from '../business/auth.service';
import {TelegramSenderService} from './telegram-sender.service';
import {telegramLinks} from '../database/schema';
import {generateId} from '../utils/uuid';

// ── Bot API update shapes (only the fields we read) ──────────────────────────
interface TgFrom {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgMessage {
  message_id: number;
  from?: TgFrom;
  chat: TgChat;
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
interface GetUpdatesResponse {
  ok: boolean;
  result?: TgUpdate[];
  description?: string;
}

// In-memory login conversation state, keyed by chatId.
interface ConversationState {
  step: 'login' | 'password';
  login?: string;
  attempts: number;
}

const POLL_TIMEOUT_S = 30;
const POLL_BACKOFF_MS = 3000;
const MAX_LOGIN_ATTEMPTS = 5;

// Uz-language bot copy.
const PROMPT_LOGIN = 'Iltimos, tizim loginini yuboring:';
const PROMPT_PASSWORD = 'Endi parolni yuboring:';
const MSG_INVALID =
  'Login yoki parol xato. Iltimos, loginni qaytadan yuboring:';
const MSG_TOO_MANY =
  "Juda ko'p urinish. Qaytadan boshlash uchun /start ni yuboring.";
const MSG_LOGOUT =
  'Chiqdingiz. Hisobotlar endi bu chatga kelmaydi. Qayta ulanish uchun /start.';

/**
 * Login-gated Telegram bot. Runs via long polling (getUpdates). A user sends
 * their dashboard login + password to the bot; on success the chat is linked
 * to their account+business (telegram_links) and reports are later forwarded
 * to it. Polling only starts when TELEGRAM_BOT_TOKEN is set.
 */
@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly conversations = new Map<string, ConversationState>();
  private offset = 0;
  private polling = false;

  constructor(
    private readonly dbService: DatabaseService,
    private readonly authService: AuthService,
    private readonly sender: TelegramSenderService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  onModuleInit(): void {
    if (!this.sender.isConfigured()) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN is not set — the Telegram bot will not start (report delivery disabled).',
      );
      return;
    }
    // Fire-and-forget: cache the bot username, then poll forever.
    void this.start();
  }

  private async start(): Promise<void> {
    const me = await this.sender.getMe();
    if (me) {
      this.logger.log(
        `Telegram bot @${me.username ?? me.first_name} started (long polling).`,
      );
    } else {
      this.logger.warn('Telegram getMe failed — starting polling anyway.');
    }
    this.polling = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return;
      }
      try {
        const updates = await this.getUpdates(token);
        for (const update of updates) {
          // Advance the offset BEFORE handling so a bad update is never
          // reprocessed (and can't wedge the loop).
          this.offset = update.update_id + 1;
          try {
            await this.handleUpdate(update);
          } catch (e) {
            this.logger.error(`handleUpdate failed: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        this.logger.error(`Telegram poll error: ${(e as Error).message}`);
        await this.sleep(POLL_BACKOFF_MS);
      }
    }
  }

  private async getUpdates(token: string): Promise<TgUpdate[]> {
    const url =
      `https://api.telegram.org/bot${token}/getUpdates` +
      `?timeout=${POLL_TIMEOUT_S}&offset=${this.offset}`;
    const res = await fetch(url);
    const data = (await res.json()) as GetUpdatesResponse;
    if (!data.ok || !data.result) {
      throw new Error(data.description ?? `getUpdates HTTP ${res.status}`);
    }
    return data.result;
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const message = update.message;
    if (!message?.chat) {
      return;
    }
    const chatId = String(message.chat.id);
    const text = (message.text ?? '').trim();
    if (!text) {
      return;
    }

    if (text === '/logout') {
      await this.handleLogout(chatId);
      return;
    }

    if (text === '/start') {
      this.conversations.set(chatId, {step: 'login', attempts: 0});
      await this.reply(chatId, PROMPT_LOGIN);
      return;
    }

    const state = this.conversations.get(chatId);
    if (!state) {
      // Any first message with no conversation → begin the login flow.
      this.conversations.set(chatId, {step: 'login', attempts: 0});
      await this.reply(chatId, PROMPT_LOGIN);
      return;
    }

    if (state.step === 'login') {
      state.login = text;
      state.step = 'password';
      await this.reply(chatId, PROMPT_PASSWORD);
      return;
    }

    // step === 'password'
    await this.handlePassword(chatId, state, message, text);
  }

  private async handlePassword(
    chatId: string,
    state: ConversationState,
    message: TgMessage,
    password: string,
  ): Promise<void> {
    const login = state.login ?? '';
    try {
      // NEVER log the password — only the caught error path runs below on
      // failure, and it never references `password`.
      const session = await this.authService.login(login, password);
      await this.upsertLink(chatId, session, message.from);
      // Security: remove the message that contained the plaintext password.
      await this.sender.deleteMessage(chatId, message.message_id);
      this.conversations.delete(chatId);
      await this.reply(
        chatId,
        `✅ Ulandingiz — ${session.business.name} / ${session.account.name}. Endi hisobotlar shu chatga keladi.`,
      );
    } catch {
      state.attempts += 1;
      if (state.attempts >= MAX_LOGIN_ATTEMPTS) {
        this.conversations.delete(chatId);
        await this.reply(chatId, MSG_TOO_MANY);
        return;
      }
      // Restart from the login step so the user can retry both fields.
      state.step = 'login';
      state.login = undefined;
      await this.reply(chatId, MSG_INVALID);
    }
  }

  private async upsertLink(
    chatId: string,
    session: Awaited<ReturnType<AuthService['login']>>,
    from: TgFrom | undefined,
  ): Promise<void> {
    const now = new Date();
    // Unique chat_id → replace any prior link for this chat.
    await this.db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
    await this.db.insert(telegramLinks).values({
      id: generateId(),
      businessId: session.business.id,
      accountType: session.account.type,
      accountId: session.account.id,
      accountLogin: session.account.login,
      accountName: session.account.name,
      chatId,
      tgUsername: from?.username ?? null,
      tgFirstName: from?.first_name ?? null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async handleLogout(chatId: string): Promise<void> {
    this.conversations.delete(chatId);
    await this.db
      .update(telegramLinks)
      .set({isActive: false, updatedAt: new Date()})
      .where(eq(telegramLinks.chatId, chatId));
    await this.reply(chatId, MSG_LOGOUT);
  }

  /** Best-effort reply — a failed send must not break the polling loop. */
  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.sender.sendMessage(chatId, text);
    } catch (e) {
      this.logger.warn(
        `reply failed for chat ${chatId}: ${(e as Error).message}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import {Injectable, Logger} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// Minimal shapes of the Bot API responses we consume.
interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
}

/**
 * Thin wrapper over the Telegram Bot API using the Node 18+ global `fetch`
 * (no telegram library). All calls target the bot identified by
 * `process.env.TELEGRAM_BOT_TOKEN`. The token is read lazily on every call so
 * the app boots fine when it is absent (`isConfigured()` is then false).
 */
@Injectable()
export class TelegramSenderService {
  private readonly logger = new Logger(TelegramSenderService.name);
  // Cached @username from getMe, used to build the connect deep-link.
  private botUsername: string | null = null;

  private get token(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  // `token` overrides the platform bot for calls made on behalf of a shop's own
  // store bot (the Mini App storefront) — see the store_bots table.
  private url(method: string, token?: string): string {
    return `${TELEGRAM_API_BASE}/bot${token ?? this.token ?? ''}/${method}`;
  }

  /** True when a bot token is configured. */
  isConfigured(): boolean {
    return !!this.token;
  }

  /** The cached bot @username (populated by getMe), or null. */
  getBotUsername(): string | null {
    return this.botUsername;
  }

  /**
   * Send a plain text message. Throws on failure so callers can react.
   * Pass `token` to send as a shop's own store bot instead of the platform bot.
   */
  async sendMessage(
    chatId: string,
    text: string,
    token?: string,
  ): Promise<TelegramMessage> {
    if (!token && !this.token) {
      throw new AppException(ErrorCode.TELEGRAM_NOT_CONFIGURED);
    }
    const res = await fetch(this.url('sendMessage', token), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({chat_id: chatId, text}),
    });
    const data = (await res.json()) as TelegramApiResponse<TelegramMessage>;
    if (!res.ok || !data.ok) {
      throw new Error(
        `Telegram sendMessage failed: ${data.description ?? `HTTP ${res.status}`}`,
      );
    }
    return data.result as TelegramMessage;
  }

  /**
   * Send an in-memory file as a document (multipart). Native fetch supports
   * FormData + Blob; the filename makes Telegram treat the payload as a named
   * document (e.g. an .xlsx report). Throws on failure so the endpoint can
   * report per-chat results.
   */
  async sendDocument(
    chatId: string,
    buffer: Buffer,
    filename: string,
    caption?: string,
  ): Promise<TelegramMessage> {
    if (!this.token) {
      throw new AppException(ErrorCode.TELEGRAM_NOT_CONFIGURED);
    }
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) {
      form.append('caption', caption);
    }
    // Wrap in a fresh Uint8Array so the Blob part has a plain ArrayBuffer
    // backing (Node's Buffer types as ArrayBufferLike, which BlobPart rejects).
    form.append('document', new Blob([new Uint8Array(buffer)]), filename);

    const res = await fetch(this.url('sendDocument'), {
      method: 'POST',
      body: form,
    });
    const data = (await res.json()) as TelegramApiResponse<TelegramMessage>;
    if (!res.ok || !data.ok) {
      throw new Error(
        `Telegram sendDocument failed: ${data.description ?? `HTTP ${res.status}`}`,
      );
    }
    return data.result as TelegramMessage;
  }

  /** Best-effort message deletion (used to scrub the password message). */
  async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    if (!this.token) {
      return false;
    }
    try {
      const res = await fetch(this.url('deleteMessage'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chat_id: chatId, message_id: messageId}),
      });
      const data = (await res.json()) as TelegramApiResponse<boolean>;
      return res.ok && data.ok;
    } catch (e) {
      this.logger.warn(`deleteMessage error: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Fetch the bot identity and cache its @username. Best-effort: returns null
   * (and logs) on any failure so startup never crashes.
   *
   * Pass `token` to identify a shop's own store bot — that call is also how a
   * pasted token is validated before it is saved, so it must NOT overwrite the
   * cached platform @username.
   */
  async getMe(token?: string): Promise<TelegramUser | null> {
    if (!token && !this.token) {
      return null;
    }
    try {
      const res = await fetch(this.url('getMe', token));
      const data = (await res.json()) as TelegramApiResponse<TelegramUser>;
      if (!res.ok || !data.ok || !data.result) {
        this.logger.warn(
          `getMe failed: ${data.description ?? `HTTP ${res.status}`}`,
        );
        return null;
      }
      if (!token) {
        this.botUsername = data.result.username ?? null;
      }
      return data.result;
    } catch (e) {
      this.logger.warn(`getMe error: ${(e as Error).message}`);
      return null;
    }
  }
}

import {Injectable, Logger} from '@nestjs/common';
import {createHmac} from 'crypto';

// Overridable only so e2e tests can point at a fake Bot API.
const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

export interface InlineButton {
  text: string;
  url?: string;
  web_app?: {url: string};
  callback_data?: string;
}

/**
 * Bot API calls the assistant needs, for any token: the shop's store bot
 * (customer side) or the platform bot (staff side, token omitted). Kept apart
 * from TelegramSenderService, whose callers expect plain text-only sends.
 */
@Injectable()
export class AssistantTelegram {
  private readonly logger = new Logger(AssistantTelegram.name);

  private platformToken(): string {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    return token;
  }

  async call<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    token?: string,
  ): Promise<T> {
    const res = await fetch(`${API}/bot${token ?? this.platformToken()}/${method}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {ok: boolean; result?: T; description?: string};
    if (!res.ok || !data.ok) {
      throw new Error(`Telegram ${method} failed: ${data.description ?? `HTTP ${res.status}`}`);
    }
    return data.result as T;
  }

  sendMessage(
    chatId: string,
    text: string,
    opts: {token?: string; buttons?: InlineButton[][]; replyTo?: number} = {},
  ): Promise<{message_id: number}> {
    return this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        link_preview_options: {is_disabled: true},
        ...(opts.buttons?.length
          ? {reply_markup: {inline_keyboard: opts.buttons}}
          : {}),
        ...(opts.replyTo
          ? {reply_parameters: {message_id: opts.replyTo, allow_sending_without_reply: true}}
          : {}),
      },
      opts.token,
    );
  }

  /** "typing…" while the model thinks. Best-effort. */
  async typing(chatId: string, token: string): Promise<void> {
    try {
      await this.call('sendChatAction', {chat_id: chatId, action: 'typing'}, token);
    } catch {
      /* cosmetic */
    }
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    buttons?: InlineButton[][],
  ): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        link_preview_options: {is_disabled: true},
        reply_markup: {inline_keyboard: buttons ?? []},
      });
    } catch (e) {
      this.logger.warn(`editMessageText: ${(e as Error).message}`);
    }
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    try {
      await this.call('answerCallbackQuery', {callback_query_id: id, text});
    } catch {
      /* the spinner just times out */
    }
  }

  /**
   * Copies a photo the customer sent the STORE bot to a staff chat via the
   * PLATFORM bot. file_ids are per bot, so the bytes are downloaded with the
   * store token and re-uploaded.
   */
  async relayPhoto(
    storeToken: string,
    fileId: string,
    staffChatId: string,
    caption: string,
  ): Promise<{message_id: number}> {
    const {bytes} = await this.downloadFile(storeToken, fileId);

    const form = new FormData();
    form.append('chat_id', staffChatId);
    form.append('caption', caption.slice(0, 1024));
    form.append('photo', new Blob([new Uint8Array(bytes)]), 'photo.jpg');
    const up = await fetch(`${API}/bot${this.platformToken()}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    const data = (await up.json()) as {ok: boolean; result?: {message_id: number}; description?: string};
    if (!up.ok || !data.ok || !data.result) {
      throw new Error(`sendPhoto failed: ${data.description ?? up.status}`);
    }
    return data.result;
  }

  /** Bytes of a file a customer sent the store bot (photos are < 20 MB). */
  async downloadFile(
    storeToken: string,
    fileId: string,
  ): Promise<{bytes: Buffer; contentType: string}> {
    const file = await this.call<{file_path?: string}>('getFile', {file_id: fileId}, storeToken);
    if (!file.file_path) throw new Error('getFile returned no path');
    const res = await fetch(`${API}/file/bot${storeToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
    const ext = file.file_path.split('.').pop()?.toLowerCase();
    const contentType =
      ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'mp4' ? 'video/mp4'
        : ext === 'oga' || ext === 'ogg' ? 'audio/ogg' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
    return {bytes: Buffer.from(await res.arrayBuffer()), contentType};
  }

  // ── Webhook of a shop's store bot ──────────────────────────────────────────

  /** Per-shop secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token. */
  static webhookSecret(businessId: string): string {
    const key = process.env.JWT_SECRET || process.env.AI_KEY_ENCRYPTION_SECRET || '';
    return createHmac('sha256', `assistant-webhook:${key}`)
      .update(businessId)
      .digest('hex');
  }

  static webhookUrl(businessId: string): string | null {
    const base = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
    if (!base) return null;
    return `${base}/telegram/store-bot/${businessId}/webhook`;
  }

  async setWebhook(businessId: string, token: string): Promise<void> {
    const url = AssistantTelegram.webhookUrl(businessId);
    if (!url) throw new Error('PUBLIC_API_URL is not set');
    await this.call(
      'setWebhook',
      {
        url,
        secret_token: AssistantTelegram.webhookSecret(businessId),
        allowed_updates: ['message'],
        drop_pending_updates: true,
      },
      token,
    );
  }

  async deleteWebhook(token: string): Promise<void> {
    await this.call('deleteWebhook', {}, token);
  }
}

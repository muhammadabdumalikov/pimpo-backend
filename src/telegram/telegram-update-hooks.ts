import {Injectable, Logger} from '@nestjs/common';

// ── Bot API update shapes (only the fields hooks read) ───────────────────────
export interface TgFrom {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
export interface TgChat {
  id: number;
  type: string;
}
export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
}
export interface TgMessage {
  message_id: number;
  from?: TgFrom;
  chat: TgChat;
  date?: number;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: {file_id: string; mime_type?: string};
  voice?: {file_id: string};
  video?: {file_id: string};
  sticker?: {file_id: string};
  reply_to_message?: TgMessage;
}
export interface TgCallbackQuery {
  id: string;
  from: TgFrom;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Returns true when it handled the update (the bot's own flow then skips it). */
export type PlatformUpdateHook = (update: TgUpdate) => Promise<boolean>;

/** A shop connected, replaced or removed its store bot token. */
export type StoreBotChangedHook = (
  businessId: string,
  token: string | null,
  previousToken: string | null,
) => Promise<void>;

/**
 * Lets other modules see the PLATFORM bot's updates before its login flow does,
 * without TelegramModule importing them (that would be a module cycle). The AI
 * assistant registers here to catch staff replies to handoff messages and the
 * "FAQ'ga qo'shish" button — otherwise, after a restart wipes the in-memory
 * login state, a staff reply would be read as a login attempt.
 */
@Injectable()
export class TelegramUpdateHooks {
  private readonly logger = new Logger(TelegramUpdateHooks.name);
  private readonly hooks: PlatformUpdateHook[] = [];
  private readonly storeBotHooks: StoreBotChangedHook[] = [];

  onStoreBotChanged(hook: StoreBotChangedHook): void {
    this.storeBotHooks.push(hook);
  }

  async storeBotChanged(
    businessId: string,
    token: string | null,
    previousToken: string | null,
  ): Promise<void> {
    for (const hook of this.storeBotHooks) {
      try {
        await hook(businessId, token, previousToken);
      } catch (e) {
        this.logger.warn(`store bot hook failed: ${(e as Error).message}`);
      }
    }
  }

  register(hook: PlatformUpdateHook): void {
    this.hooks.push(hook);
  }

  async dispatch(update: TgUpdate): Promise<boolean> {
    for (const hook of this.hooks) {
      try {
        if (await hook(update)) return true;
      } catch (e) {
        this.logger.error(`platform update hook failed: ${(e as Error).message}`);
      }
    }
    return false;
  }
}

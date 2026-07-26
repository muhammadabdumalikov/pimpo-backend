/** BullMQ queue name for outbound Telegram notifications. Shared by the module
 *  (registerQueue), the producer (TelegramNotifyService) and the processor. */
export const TELEGRAM_QUEUE = 'telegram-notifications';

/** Job payload enqueued for delivery — a pre-rendered message for a business. */
export interface TelegramJobData {
  businessId: string;
  event: string;
  message: string;
  // Chat ids already delivered — appended as the worker progresses so a retry
  // never re-sends to a chat that already succeeded.
  sentChatIds?: string[];
}

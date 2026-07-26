import {Logger} from '@nestjs/common';
import {Processor, WorkerHost} from '@nestjs/bullmq';
import {Job} from 'bullmq';
import {TelegramSenderService} from './telegram-sender.service';
import {TelegramNotifyService} from './telegram-notify.service';
import {TELEGRAM_QUEUE, TelegramJobData} from './telegram.constants';

/**
 * Drains the `telegram-notifications` queue: resolves the business's active
 * chats and delivers the pre-rendered message to each.
 *
 * - `concurrency: 1` + a global `limiter` (25 msg/s) keep us under Telegram's
 *   global send limit; per-chat spacing is left to retry/backoff for now.
 * - Delivered chats are recorded on the job (`sentChatIds`) so a retry (after a
 *   failed chat throws) never re-sends to a chat that already succeeded.
 * - Any chat failure throws → BullMQ retries the whole job with exponential
 *   backoff (this is how a Telegram 429 / transient network error is handled).
 *
 * Registered only when Redis is configured (see TelegramModule).
 */
@Processor(TELEGRAM_QUEUE, {
  concurrency: 1,
  limiter: {max: 25, duration: 1000},
})
export class TelegramNotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramNotificationsProcessor.name);

  constructor(
    private readonly sender: TelegramSenderService,
    private readonly notify: TelegramNotifyService,
  ) {
    super();
  }

  async process(job: Job<TelegramJobData>): Promise<void> {
    const {businessId, message} = job.data;
    // Bot token may have been removed since enqueue — nothing to deliver.
    if (!this.sender.isConfigured()) return;

    const sent = new Set(job.data.sentChatIds ?? []);
    const chatIds = await this.notify.listActiveChatIds(businessId);

    for (const chatId of chatIds) {
      if (sent.has(chatId)) continue; // already delivered on a previous attempt
      await this.sender.sendMessage(chatId, message); // throws → job retried
      sent.add(chatId);
      // Persist progress so a later-chat failure doesn't re-send earlier chats.
      await job.updateData({...job.data, sentChatIds: [...sent]});
    }
  }
}

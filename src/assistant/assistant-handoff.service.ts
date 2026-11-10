import {Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {and, asc, desc, eq, inArray, isNull, lt, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  aiAssistantFaqs,
  branches,
  businesses,
  customerChatHandoffMessages,
  customerChatHandoffs,
  customerChatMessages,
  customerChats,
  staff,
  storeBots,
  telegramLinks,
  type CustomerChat,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {PermissionService} from '../permission/permission.service';
import type {IAccount} from '../business/types';
import {
  TelegramUpdateHooks,
  type TgCallbackQuery,
  type TgMessage,
  type TgUpdate,
} from '../telegram/telegram-update-hooks';
import {AssistantTelegram, type InlineButton} from './assistant-telegram';
import {detectLocale, t, type ChatLocale} from './assistant-text';
import {isOpenAt} from '../branch/working-hours';

/** Q18: after a staff reply the bot stays out of the chat this long. */
const HUMAN_WINDOW_MS = 30 * 60 * 1000;
/** Q6: nobody answered within this → the customer gets a holding message. */
const NO_ANSWER_MS = 15 * 60 * 1000;
/** Q12. */
const RETENTION_DAYS = 90;

const REASON_UZ: Record<string, string> = {
  unknown: 'bot javobni bilmaydi',
  photo: 'rasm yubordi',
  rate_limit: "juda ko'p savol",
  quota: 'oylik AI limiti tugagan',
  haggle: 'narx kelishmoqchi',
  customer_asked: "operator so'radi",
  complaint: 'shikoyat',
  follow_up: 'davomi',
};

interface Recipient {
  chatId: string;
  accountId: string;
  name: string;
}

export interface HandoffInput {
  businessId: string;
  chat: CustomerChat;
  storeToken: string;
  reason: string;
  summary: string | null;
  locale: ChatLocale;
  /** A photo/document the customer sent (store-bot file id). */
  photoFileId?: string | null;
}

/**
 * Passing a customer question to people (AI-YORDAMCHI.md §2.1): the platform
 * bot DMs the owner and every linked staff member holding
 * `customer:chat:reply`; whoever replies first claims it, the reply goes back
 * to the customer through the shop's own bot, and the bot then keeps out of
 * that chat for 30 minutes.
 */
@Injectable()
export class AssistantHandoffService implements OnModuleInit {
  private readonly logger = new Logger(AssistantHandoffService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly tg: AssistantTelegram,
    private readonly permissions: PermissionService,
    private readonly hooks: TelegramUpdateHooks,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  onModuleInit(): void {
    this.hooks.register((u) => this.onPlatformUpdate(u));
  }

  // ── Creating a handoff ─────────────────────────────────────────────────────

  async create(input: HandoffInput): Promise<void> {
    const {businessId, chat, storeToken, locale} = input;
    const id = generateId();
    await this.db.insert(customerChatHandoffs).values({
      id,
      businessId,
      chatId: chat.id,
      reason: input.reason,
      summary: input.summary,
    });

    // The customer hears either "an operator will answer" or, outside working
    // hours, when we will (the 15-minute holding message is then skipped).
    const closed = await this.allBranchesClosed(businessId);
    const customerText = closed.closed
      ? t(locale, 'afterHours', {hours: closed.hours ? ` (${closed.hours})` : ''})
      : t(
          locale,
          input.reason === 'photo'
            ? 'handoffPhoto'
            : input.reason === 'rate_limit'
              ? 'rateLimit'
              : 'handoff',
        );
    await this.sendToCustomer(chat, storeToken, customerText, 'system');
    if (closed.closed) {
      await this.db
        .update(customerChatHandoffs)
        .set({autoRepliedAt: new Date()})
        .where(eq(customerChatHandoffs.id, id));
    }

    await this.notifyStaff(businessId, id, chat, input);
  }

  /**
   * Q18: while a person is handling the chat, the customer's new messages go
   * straight to that person (or to everyone, if they unlinked meanwhile).
   */
  async forwardToHuman(
    businessId: string,
    chat: CustomerChat,
    storeToken: string,
    text: string | null,
    photoFileId: string | null,
  ): Promise<void> {
    const [latest] = await this.db
      .select({id: customerChatHandoffs.id})
      .from(customerChatHandoffs)
      .where(eq(customerChatHandoffs.chatId, chat.id))
      .orderBy(desc(customerChatHandoffs.createdAt))
      .limit(1);
    const handoffId =
      latest?.id ??
      (await this.db
        .insert(customerChatHandoffs)
        .values({
          id: generateId(),
          businessId,
          chatId: chat.id,
          reason: 'follow_up',
          status: 'claimed',
        })
        .returning({id: customerChatHandoffs.id}))[0].id;

    let recipients = await this.recipients(businessId);
    const owner = recipients.filter((r) => r.accountId === chat.humanAccountId);
    if (owner.length) recipients = owner;

    const header = `💬 ${this.customerLabel(chat)}:\n`;
    for (const r of recipients) {
      try {
        const sent = photoFileId
          ? await this.tg.relayPhoto(storeToken, photoFileId, r.chatId, header + (text ?? ''))
          : await this.tg.sendMessage(r.chatId, header + (text ?? ''));
        await this.rememberCopy(handoffId, r.chatId, sent.message_id);
      } catch (e) {
        this.logger.warn(`forwardToHuman → ${r.chatId}: ${(e as Error).message}`);
      }
    }
  }

  private async notifyStaff(
    businessId: string,
    handoffId: string,
    chat: CustomerChat,
    input: HandoffInput,
  ): Promise<void> {
    const recipients = await this.recipients(businessId);
    if (!recipients.length) {
      this.logger.warn(`handoff ${handoffId}: business ${businessId} has nobody linked to receive it`);
      return;
    }
    const [biz] = await this.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    const recent = await this.db
      .select({role: customerChatMessages.role, text: customerChatMessages.text})
      .from(customerChatMessages)
      .where(eq(customerChatMessages.chatId, chat.id))
      .orderBy(desc(customerChatMessages.createdAt))
      .limit(6);
    const transcript = recent
      .reverse()
      .filter((m) => m.text)
      .map((m) => `${m.role === 'customer' ? '👤' : m.role === 'staff' ? '🧑‍💼' : '🤖'} ${m.text!.slice(0, 300)}`)
      .join('\n');

    const text =
      `🔔 Mijoz savoli — ${biz?.name ?? ''}\n` +
      `👤 ${this.customerLabel(chat)}\n` +
      `Sabab: ${REASON_UZ[input.reason] ?? input.reason}` +
      (input.summary ? `\n📝 ${input.summary}` : '') +
      (transcript ? `\n\n${transcript}` : '') +
      `\n\n↩️ Javob yozish uchun shu xabarga reply qiling.`;

    for (const r of recipients) {
      try {
        const sent = input.photoFileId
          ? await this.tg.relayPhoto(input.storeToken, input.photoFileId, r.chatId, text)
          : await this.tg.sendMessage(r.chatId, text);
        await this.rememberCopy(handoffId, r.chatId, sent.message_id);
      } catch (e) {
        this.logger.warn(`handoff ${handoffId} → ${r.chatId}: ${(e as Error).message}`);
      }
    }
  }

  private async rememberCopy(handoffId: string, staffChatId: string, messageId: number) {
    await this.db
      .insert(customerChatHandoffMessages)
      .values({id: generateId(), handoffId, staffChatId, messageId})
      .onConflictDoNothing();
  }

  /** Linked chats of the owner + staff allowed to answer customers. */
  async recipients(businessId: string): Promise<Recipient[]> {
    const links = await this.db
      .select({
        chatId: telegramLinks.chatId,
        accountType: telegramLinks.accountType,
        accountId: telegramLinks.accountId,
        name: telegramLinks.accountName,
      })
      .from(telegramLinks)
      .where(and(eq(telegramLinks.businessId, businessId), eq(telegramLinks.isActive, true)));
    const out: Recipient[] = [];
    for (const l of links) {
      const account = await this.accountOf(businessId, l.accountType, l.accountId);
      if (account && (await this.permissions.can(account, 'customer:chat:reply'))) {
        out.push({chatId: l.chatId, accountId: l.accountId, name: l.name});
      }
    }
    return out;
  }

  private async accountOf(
    businessId: string,
    type: string,
    accountId: string,
  ): Promise<IAccount | null> {
    if (type === 'business') {
      return accountId === businessId ? {type: 'business', id: businessId, businessId} : null;
    }
    const [member] = await this.db
      .select({roleId: staff.roleId, isActive: staff.isActive, businessId: staff.businessId})
      .from(staff)
      .where(eq(staff.id, accountId))
      .limit(1);
    if (!member?.isActive || member.businessId !== businessId) return null;
    return {type: 'staff', id: accountId, businessId, roleId: member.roleId ?? undefined};
  }

  // ── Staff side: replies and the FAQ button ─────────────────────────────────

  private async onPlatformUpdate(update: TgUpdate): Promise<boolean> {
    if (update.callback_query?.data?.startsWith('faq:')) {
      await this.onFaqButton(update.callback_query);
      return true;
    }
    const msg = update.message;
    if (msg?.reply_to_message && msg.chat.type === 'private') {
      return this.onStaffReply(msg);
    }
    return false;
  }

  private async onStaffReply(msg: TgMessage): Promise<boolean> {
    const staffChatId = String(msg.chat.id);
    const [copy] = await this.db
      .select({handoffId: customerChatHandoffMessages.handoffId})
      .from(customerChatHandoffMessages)
      .where(
        and(
          eq(customerChatHandoffMessages.staffChatId, staffChatId),
          eq(customerChatHandoffMessages.messageId, msg.reply_to_message!.message_id),
        ),
      )
      .limit(1);
    if (!copy) return false; // a reply to something else — not ours

    const [handoff] = await this.db
      .select()
      .from(customerChatHandoffs)
      .where(eq(customerChatHandoffs.id, copy.handoffId))
      .limit(1);
    if (!handoff) return true;
    const [chat] = await this.db
      .select()
      .from(customerChats)
      .where(eq(customerChats.id, handoff.chatId))
      .limit(1);
    if (!chat) return true;

    // Who is replying, and may they? Checked now, not when the copy was sent:
    // the permission may have been taken away since.
    const [link] = await this.db
      .select()
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.chatId, staffChatId),
          eq(telegramLinks.businessId, handoff.businessId),
          eq(telegramLinks.isActive, true),
        ),
      )
      .limit(1);
    const account = link
      ? await this.accountOf(handoff.businessId, link.accountType, link.accountId)
      : null;
    if (!link || !account || !(await this.permissions.can(account, 'customer:chat:reply'))) {
      await this.safeSend(staffChatId, "⛔ Mijozlarga javob yozish huquqingiz yo'q.");
      return true;
    }

    const text = (msg.text ?? '').trim();
    if (!text) {
      await this.safeSend(staffChatId, 'Hozircha faqat matnli javob yuboriladi.');
      return true;
    }

    const token = await this.storeToken(handoff.businessId);
    if (!token) {
      await this.safeSend(staffChatId, "⚠️ Do'kon boti uzilgan — javob yuborilmadi.");
      return true;
    }

    let rowId: string;
    try {
      rowId = await this.replyAsStaff(chat, token, text, {
        accountId: link.accountId,
        name: link.accountName,
        skipStaffChatId: staffChatId,
      });
    } catch (e) {
      this.logger.warn(`staff reply relay failed: ${(e as Error).message}`);
      await this.safeSend(staffChatId, '⚠️ Mijozga yetkazib bo\'lmadi (botni bloklagan bo\'lishi mumkin).');
      return true;
    }

    // A photo question ("shu bormi?") means nothing without the photo, so it
    // is not offered for the FAQ.
    const buttons: InlineButton[][] =
      handoff.reason === 'photo'
        ? []
        : [[{text: "➕ FAQ'ga qo'shish", callback_data: `faq:${rowId}`}]];
    try {
      await this.tg.sendMessage(staffChatId, '✅ Mijozga yuborildi.', {buttons, replyTo: msg.message_id});
    } catch {
      /* confirmation only */
    }
    return true;
  }

  /**
   * A person answers the customer — from Telegram (reply to a handoff copy)
   * or from the inbox. Sends through the shop's bot, records it, makes the
   * person the assignee, keeps the bot out for 30 minutes (Q18) and claims
   * every open handoff of the chat, telling the other staff who took it.
   * Returns the stored message id. Throws when Telegram refuses the send.
   */
  async replyAsStaff(
    chat: CustomerChat,
    storeToken: string,
    text: string,
    actor: {accountId: string; name: string; skipStaffChatId?: string},
  ): Promise<string> {
    const rowId = await this.sendToCustomer(chat, storeToken, text, 'staff', actor.accountId);
    const now = new Date();
    await this.db
      .update(customerChats)
      .set({
        humanUntil: new Date(now.getTime() + HUMAN_WINDOW_MS),
        humanAccountId: actor.accountId,
      })
      .where(eq(customerChats.id, chat.id));

    const claimed = await this.db
      .update(customerChatHandoffs)
      .set({
        status: 'claimed',
        claimedByAccountId: actor.accountId,
        claimedByName: actor.name,
        claimedAt: now,
      })
      .where(
        and(
          eq(customerChatHandoffs.chatId, chat.id),
          inArray(customerChatHandoffs.status, ['open', 'auto_replied']),
        ),
      )
      .returning({id: customerChatHandoffs.id});
    if (claimed.length) {
      const copies = await this.db
        .select()
        .from(customerChatHandoffMessages)
        .where(inArray(customerChatHandoffMessages.handoffId, claimed.map((c) => c.id)));
      for (const c of copies) {
        if (c.staffChatId === actor.skipStaffChatId) continue;
        await this.tg.editMessageText(
          c.staffChatId,
          c.messageId,
          `✅ ${actor.name} javob berdi — ${this.customerLabel(chat)}`,
        );
      }
    }
    return rowId;
  }

  /** "FAQ'ga qo'shish": the customer's question before this staff answer + the answer. */
  private async onFaqButton(cb: TgCallbackQuery): Promise<void> {
    const rowId = cb.data!.slice(4);
    const [answer] = await this.db
      .select()
      .from(customerChatMessages)
      .where(and(eq(customerChatMessages.id, rowId), eq(customerChatMessages.role, 'staff')))
      .limit(1);
    if (!answer?.text) {
      await this.tg.answerCallback(cb.id, 'Topilmadi');
      return;
    }
    // Only someone of that shop who may answer customers may grow its FAQ.
    const [link] = await this.db
      .select()
      .from(telegramLinks)
      .where(
        and(
          eq(telegramLinks.chatId, String(cb.from.id)),
          eq(telegramLinks.businessId, answer.businessId),
          eq(telegramLinks.isActive, true),
        ),
      )
      .limit(1);
    const account = link ? await this.accountOf(answer.businessId, link.accountType, link.accountId) : null;
    if (!account || !(await this.permissions.can(account, 'customer:chat:reply'))) {
      await this.tg.answerCallback(cb.id, "Huquq yo'q");
      return;
    }
    const [question] = await this.db
      .select({text: customerChatMessages.text})
      .from(customerChatMessages)
      .where(
        and(
          eq(customerChatMessages.chatId, answer.chatId),
          eq(customerChatMessages.role, 'customer'),
          lt(customerChatMessages.createdAt, answer.createdAt),
        ),
      )
      .orderBy(desc(customerChatMessages.createdAt))
      .limit(1);
    if (!question?.text) {
      await this.tg.answerCallback(cb.id, "Mijoz savoli matn emas — FAQ'ni sozlamalarda qo'shing");
      return;
    }
    await this.db.insert(aiAssistantFaqs).values({
      id: generateId(),
      businessId: answer.businessId,
      question: question.text.slice(0, 1000),
      answer: answer.text.slice(0, 2000),
      source: 'handoff',
    });
    await this.tg.answerCallback(cb.id, "FAQ'ga qo'shildi");
    if (cb.message) {
      await this.tg.editMessageText(
        String(cb.message.chat.id),
        cb.message.message_id,
        "✅ Mijozga yuborildi. FAQ'ga qo'shildi — bot keyingi safar o'zi javob beradi.",
      );
    }
  }

  // ── Timers ─────────────────────────────────────────────────────────────────

  /** Q6: nobody answered in 15 minutes → tell the customer we're on it. */
  @Cron('*/1 * * * *', {name: 'assistant-handoff-holding'})
  async sendHoldingMessages(): Promise<void> {
    const due = await this.db
      .select({id: customerChatHandoffs.id, chatId: customerChatHandoffs.chatId})
      .from(customerChatHandoffs)
      .where(
        and(
          eq(customerChatHandoffs.status, 'open'),
          isNull(customerChatHandoffs.autoRepliedAt),
          lt(customerChatHandoffs.createdAt, new Date(Date.now() - NO_ANSWER_MS)),
          // Never dig up old ones (e.g. after downtime).
          sql`${customerChatHandoffs.createdAt} > now() - interval '2 hours'`,
        ),
      )
      .limit(50);
    for (const h of due) {
      // Claim the row first so two ticks never both send.
      const [won] = await this.db
        .update(customerChatHandoffs)
        .set({status: 'auto_replied', autoRepliedAt: new Date()})
        .where(and(eq(customerChatHandoffs.id, h.id), eq(customerChatHandoffs.status, 'open')))
        .returning({id: customerChatHandoffs.id});
      if (!won) continue;
      const [chat] = await this.db.select().from(customerChats).where(eq(customerChats.id, h.chatId)).limit(1);
      if (!chat) continue;
      const token = await this.storeToken(chat.businessId);
      if (!token) continue;
      const locale = await this.chatLocale(chat.id);
      try {
        await this.sendToCustomer(chat, token, t(locale, 'noAnswerYet'), 'system');
      } catch (e) {
        this.logger.warn(`holding message failed: ${(e as Error).message}`);
      }
    }
  }

  /** Q12: conversations are kept 90 days. */
  @Cron('15 4 * * *', {name: 'assistant-retention', timeZone: 'Asia/Tashkent'})
  async prune(): Promise<void> {
    const cutoff = sql`now() - make_interval(days => ${RETENTION_DAYS})`;
    await this.db.delete(customerChatMessages).where(lt(customerChatMessages.createdAt, cutoff));
    await this.db.delete(customerChatHandoffs).where(lt(customerChatHandoffs.createdAt, cutoff));
    await this.db.delete(customerChats).where(lt(customerChats.lastMessageAt, cutoff));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Sends through the shop's bot and records it. Returns the message row id. */
  async sendToCustomer(
    chat: CustomerChat,
    storeToken: string,
    text: string,
    role: 'bot' | 'staff' | 'system',
    staffAccountId?: string,
    buttons?: InlineButton[][],
  ): Promise<string> {
    await this.tg.sendMessage(chat.telegramChatId, text, {token: storeToken, buttons});
    const id = generateId();
    await this.db.insert(customerChatMessages).values({
      id,
      businessId: chat.businessId,
      chatId: chat.id,
      role,
      text,
      staffAccountId: staffAccountId ?? null,
    });
    await this.db
      .update(customerChats)
      .set({lastMessageAt: new Date()})
      .where(eq(customerChats.id, chat.id));
    return id;
  }

  async storeToken(businessId: string): Promise<string | null> {
    const [row] = await this.db
      .select({token: storeBots.botToken})
      .from(storeBots)
      .where(eq(storeBots.businessId, businessId))
      .limit(1);
    return row?.token ?? null;
  }

  async chatLocale(chatId: string): Promise<ChatLocale> {
    const [last] = await this.db
      .select({text: customerChatMessages.text})
      .from(customerChatMessages)
      .where(
        and(
          eq(customerChatMessages.chatId, chatId),
          eq(customerChatMessages.role, 'customer'),
          sql`${customerChatMessages.text} IS NOT NULL`,
        ),
      )
      .orderBy(desc(customerChatMessages.createdAt))
      .limit(1);
    return detectLocale(last?.text);
  }

  /**
   * Closed = hours are set for at least one branch and none is open now.
   * Unknown hours never count as closed.
   */
  private async allBranchesClosed(
    businessId: string,
  ): Promise<{closed: boolean; hours: string | null}> {
    const rows = await this.db
      .select({wh: branches.workingHours, isDefault: branches.isDefault})
      .from(branches)
      .where(and(eq(branches.businessId, businessId), eq(branches.isActive, true)))
      .orderBy(desc(branches.isDefault), asc(branches.name));
    const states = rows.map((r) => isOpenAt(r.wh));
    if (!states.some((s) => s !== null) || states.some((s) => s === true)) {
      return {closed: false, hours: null};
    }
    const main = rows.find((r) => r.wh)?.wh;
    const day = main ? Object.values(main).find((d) => d) : null;
    return {closed: true, hours: day ? `${day.open}–${day.close}` : null};
  }

  private customerLabel(chat: CustomerChat): string {
    const name = chat.firstName || 'Mijoz';
    return chat.username ? `${name} (@${chat.username})` : name;
  }

  private async safeSend(chatId: string, text: string): Promise<void> {
    try {
      await this.tg.sendMessage(chatId, text);
    } catch {
      /* nothing to do */
    }
  }
}

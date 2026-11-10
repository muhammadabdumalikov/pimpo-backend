import {Injectable, Logger} from '@nestjs/common';
import {and, asc, desc, eq, ilike, inArray, lt, ne, or, sql, type SQL} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  aiAssistantFaqs,
  assistantQuickReplies,
  businesses,
  customerChatHandoffs,
  customerChatMessages,
  customerChatNotes,
  customerChatReads,
  customerChats,
  debtPayments,
  orders,
  staff,
  telegramLinks,
  userDebts,
  users,
  type CustomerChat,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {PermissionService} from '../permission/permission.service';
import type {IAccount} from '../business/types';
import {AssistantHandoffService} from './assistant-handoff.service';
import {AssistantTelegram} from './assistant-telegram';

/** A bare "YYYY-MM-DD HH:MM:SS" from a raw subquery, read as UTC. */
const utc = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(`${String(v).replace(' ', 'T')}Z`);

export type ChatStatus = 'bot' | 'waiting' | 'human' | 'closed';
const PAGE = 50;
const MESSAGES_PAGE = 60;

/**
 * The inbox (AI-YORDAMCHI.md, I1): every customer chat of a shop, answered
 * from the dashboard. Shares the reply path with the Telegram relay
 * (AssistantHandoffService.replyAsStaff), so both see one conversation.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly handoff: AssistantHandoffService,
    private readonly tg: AssistantTelegram,
    private readonly permissions: PermissionService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** Derived, never stored — see the I1 plan. */
  private statusSql(): SQL<ChatStatus> {
    return sql<ChatStatus>`CASE
      WHEN ${customerChats.closedAt} IS NOT NULL THEN 'closed'
      WHEN EXISTS (SELECT 1 FROM ${customerChatHandoffs} h
                    WHERE h.chat_id = ${customerChats.id}
                      AND h.status IN ('open', 'auto_replied')) THEN 'waiting'
      WHEN ${customerChats.botPaused} OR ${customerChats.humanUntil} > now() THEN 'human'
      ELSE 'bot' END`;
  }

  private unreadSql(accountId: string): SQL<number> {
    return sql<number>`(SELECT count(*)::int FROM ${customerChatMessages} m
      WHERE m.chat_id = ${customerChats.id} AND m.role = 'customer'
        AND m.created_at > COALESCE(
          (SELECT r.last_read_at FROM ${customerChatReads} r
            WHERE r.chat_id = ${customerChats.id} AND r.account_id = ${accountId}),
          'epoch'::timestamp))`;
  }

  // ── List ───────────────────────────────────────────────────────────────────

  async list(
    account: IAccount,
    q: {status?: ChatStatus | 'all'; search?: string; mine?: boolean; unanswered?: boolean; before?: string},
  ) {
    const status = this.statusSql();
    const lastRole = sql<string>`(SELECT m.role FROM ${customerChatMessages} m
      WHERE m.chat_id = ${customerChats.id} ORDER BY m.created_at DESC LIMIT 1)`;
    const conds: (SQL | undefined)[] = [eq(customerChats.businessId, account.businessId)];
    if (q.status && q.status !== 'all') conds.push(sql`${status} = ${q.status}`);
    if (q.mine) conds.push(eq(customerChats.humanAccountId, account.id));
    if (q.unanswered) conds.push(sql`${lastRole} = 'customer'`);
    if (q.before) conds.push(lt(customerChats.lastMessageAt, new Date(q.before)));
    const term = q.search?.trim();
    if (term) {
      const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`;
      conds.push(
        or(
          ilike(customerChats.firstName, like),
          ilike(customerChats.username, like),
          sql`EXISTS (SELECT 1 FROM ${customerChatMessages} m
                WHERE m.chat_id = ${customerChats.id} AND m.text ILIKE ${like})`,
        ),
      );
    }

    const rows = await this.db
      .select({
        id: customerChats.id,
        firstName: customerChats.firstName,
        username: customerChats.username,
        lastMessageAt: customerChats.lastMessageAt,
        assigneeId: customerChats.humanAccountId,
        botPaused: customerChats.botPaused,
        customerId: customerChats.customerId,
        customerName: users.name,
        status,
        unread: this.unreadSql(account.id),
        lastText: sql<string | null>`(SELECT m.text FROM ${customerChatMessages} m
          WHERE m.chat_id = ${customerChats.id} ORDER BY m.created_at DESC LIMIT 1)`,
        lastRole,
        lastMedia: sql<boolean>`(SELECT m.media IS NOT NULL FROM ${customerChatMessages} m
          WHERE m.chat_id = ${customerChats.id} ORDER BY m.created_at DESC LIMIT 1)`,
        lastStaffId: sql<string | null>`(SELECT m.staff_account_id FROM ${customerChatMessages} m
          WHERE m.chat_id = ${customerChats.id} ORDER BY m.created_at DESC LIMIT 1)`,
        // Raw subqueries come back as bare text with no zone; the columns are
        // UTC (timestamp without time zone), so say so before parsing.
        waitingSince: sql<Date | null>`(SELECT min(h.created_at) FROM ${customerChatHandoffs} h
          WHERE h.chat_id = ${customerChats.id} AND h.status IN ('open', 'auto_replied'))`.mapWith(utc),
      })
      .from(customerChats)
      .leftJoin(users, eq(users.id, customerChats.customerId))
      .where(and(...conds))
      .orderBy(desc(customerChats.lastMessageAt))
      .limit(PAGE + 1);

    const names = await this.accountNames(account.businessId);
    const page = rows.slice(0, PAGE);
    return {
      chats: page.map((r) => ({
        id: r.id,
        name: r.firstName || 'Mijoz',
        username: r.username,
        status: r.status,
        unread: r.unread,
        botPaused: r.botPaused,
        lastMessage: {
          text: r.lastText,
          role: r.lastRole,
          hasMedia: !!r.lastMedia,
          staffName: r.lastStaffId ? names.get(r.lastStaffId) ?? null : null,
          at: r.lastMessageAt,
        },
        waitingSince: r.waitingSince,
        assignee: r.assigneeId ? {id: r.assigneeId, name: names.get(r.assigneeId) ?? '—'} : null,
        customer: r.customerId ? {id: r.customerId, name: r.customerName} : null,
      })),
      nextBefore: rows.length > PAGE ? page[page.length - 1].lastMessageAt : null,
    };
  }

  /** Tab counters + the sidebar badge. */
  async counts(account: IAccount) {
    const status = this.statusSql();
    const [row] = await this.db
      .select({
        all: sql<number>`count(*)::int`,
        bot: sql<number>`count(*) FILTER (WHERE ${status} = 'bot')::int`,
        waiting: sql<number>`count(*) FILTER (WHERE ${status} = 'waiting')::int`,
        human: sql<number>`count(*) FILTER (WHERE ${status} = 'human')::int`,
        closed: sql<number>`count(*) FILTER (WHERE ${status} = 'closed')::int`,
        mine: sql<number>`count(*) FILTER (WHERE ${customerChats.humanAccountId} = ${account.id} AND ${customerChats.closedAt} IS NULL)::int`,
        unreadChats: sql<number>`count(*) FILTER (WHERE ${this.unreadSql(account.id)} > 0)::int`,
      })
      .from(customerChats)
      .where(eq(customerChats.businessId, account.businessId));
    return row;
  }

  // ── One chat ───────────────────────────────────────────────────────────────

  async detail(account: IAccount, chatId: string) {
    const chat = await this.chatOrThrow(account.businessId, chatId);
    const [{status}] = await this.db
      .select({status: this.statusSql()})
      .from(customerChats)
      .where(eq(customerChats.id, chatId));
    const names = await this.accountNames(account.businessId);
    const notes = await this.db
      .select()
      .from(customerChatNotes)
      .where(eq(customerChatNotes.chatId, chatId))
      .orderBy(desc(customerChatNotes.createdAt));
    const canSeeCustomer = await this.permissions.can(account, 'customer:read');
    return {
      id: chat.id,
      name: chat.firstName || 'Mijoz',
      username: chat.username,
      telegramLink: chat.username ? `https://t.me/${chat.username}` : null,
      status,
      botPaused: chat.botPaused,
      humanUntil: chat.humanUntil && chat.humanUntil > new Date() ? chat.humanUntil : null,
      closedAt: chat.closedAt,
      createdAt: chat.createdAt,
      assignee: chat.humanAccountId
        ? {id: chat.humanAccountId, name: names.get(chat.humanAccountId) ?? '—'}
        : null,
      notes: notes.map((n) => ({
        id: n.id,
        text: n.text,
        authorName: n.authorName,
        mine: n.accountId === account.id,
        createdAt: n.createdAt,
      })),
      // Customer details are only shown to someone who may read customers.
      canSeeCustomer,
      customer: canSeeCustomer && chat.customerId ? await this.customerCard(account.businessId, chat.customerId) : null,
      customerSuggestions:
        canSeeCustomer && !chat.customerId ? await this.suggestCustomers(account.businessId, chat) : [],
    };
  }

  async messages(account: IAccount, chatId: string, before?: string) {
    await this.chatOrThrow(account.businessId, chatId);
    const rows = await this.db
      .select({
        id: customerChatMessages.id,
        role: customerChatMessages.role,
        text: customerChatMessages.text,
        media: customerChatMessages.media,
        staffAccountId: customerChatMessages.staffAccountId,
        flag: customerChatMessages.flag,
        model: customerChatMessages.model,
        toolCalls: customerChatMessages.toolCalls,
        createdAt: customerChatMessages.createdAt,
      })
      .from(customerChatMessages)
      .where(
        and(
          eq(customerChatMessages.chatId, chatId),
          before ? lt(customerChatMessages.createdAt, new Date(before)) : undefined,
        ),
      )
      .orderBy(desc(customerChatMessages.createdAt))
      .limit(MESSAGES_PAGE + 1);

    // Opening the newest page marks the chat read for this account.
    if (!before) {
      await this.db
        .insert(customerChatReads)
        .values({chatId, accountId: account.id, lastReadAt: new Date()})
        .onConflictDoUpdate({
          target: [customerChatReads.chatId, customerChatReads.accountId],
          set: {lastReadAt: new Date()},
        });
    }

    const names = await this.accountNames(account.businessId);
    const page = rows.slice(0, MESSAGES_PAGE).reverse();
    return {
      messages: page
        // A bot row with no text is an ignored message or a handoff marker.
        .filter((m) => m.text || m.media)
        .map((m) => ({
          id: m.id,
          role: m.role as 'customer' | 'bot' | 'staff' | 'system',
          text: m.text,
          media: m.media ? {kind: m.media.kind} : null,
          staffName: m.staffAccountId ? names.get(m.staffAccountId) ?? '—' : null,
          flag: m.flag,
          ai: !!m.model,
          tools: Array.isArray(m.toolCalls)
            ? (m.toolCalls as {name: string}[]).map((c) => c.name)
            : [],
          createdAt: m.createdAt,
        })),
      hasMore: rows.length > MESSAGES_PAGE,
    };
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async reply(account: IAccount, chatId: string, text: string) {
    const chat = await this.chatOrThrow(account.businessId, chatId);
    const token = await this.handoff.storeToken(account.businessId);
    if (!token) throw new AppException(ErrorCode.ASSISTANT_STORE_BOT_REQUIRED);
    const name = await this.accountName(account);
    try {
      const id = await this.handoff.replyAsStaff(chat, token, text.trim(), {
        accountId: account.id,
        name,
      });
      if (chat.closedAt) {
        await this.db.update(customerChats).set({closedAt: null}).where(eq(customerChats.id, chatId));
      }
      return {id};
    } catch (e) {
      this.logger.warn(`inbox reply failed: ${(e as Error).message}`);
      throw new AppException(ErrorCode.INBOX_SEND_FAILED);
    }
  }

  /** "Botni to'xtatish" / "Botga qaytarish". */
  async setBotPaused(account: IAccount, chatId: string, paused: boolean) {
    await this.chatOrThrow(account.businessId, chatId);
    await this.db
      .update(customerChats)
      .set(
        paused
          ? {botPaused: true, humanAccountId: account.id}
          : {botPaused: false, humanUntil: null},
      )
      .where(eq(customerChats.id, chatId));
    return this.detail(account, chatId);
  }

  async close(account: IAccount, chatId: string) {
    await this.chatOrThrow(account.businessId, chatId);
    await this.db
      .update(customerChats)
      // The next conversation starts with the bot again.
      .set({closedAt: new Date(), botPaused: false, humanUntil: null})
      .where(eq(customerChats.id, chatId));
    await this.db
      .update(customerChatHandoffs)
      .set({status: 'closed'})
      .where(
        and(
          eq(customerChatHandoffs.chatId, chatId),
          inArray(customerChatHandoffs.status, ['open', 'auto_replied']),
        ),
      );
    return this.detail(account, chatId);
  }

  async reopen(account: IAccount, chatId: string) {
    await this.chatOrThrow(account.businessId, chatId);
    await this.db.update(customerChats).set({closedAt: null}).where(eq(customerChats.id, chatId));
    return this.detail(account, chatId);
  }

  async assign(account: IAccount, chatId: string, assigneeId: string | null) {
    await this.chatOrThrow(account.businessId, chatId);
    if (assigneeId) {
      const agents = await this.agents(account.businessId);
      if (!agents.some((a) => a.id === assigneeId)) {
        throw new AppException(ErrorCode.INBOX_AGENT_INVALID);
      }
    }
    await this.db
      .update(customerChats)
      .set({humanAccountId: assigneeId})
      .where(eq(customerChats.id, chatId));
    return this.detail(account, chatId);
  }

  async linkCustomer(account: IAccount, chatId: string, customerId: string | null) {
    await this.permissions.assert(account, 'customer:read');
    await this.chatOrThrow(account.businessId, chatId);
    if (customerId) {
      const [u] = await this.db
        .select({id: users.id})
        .from(users)
        .where(and(eq(users.id, customerId), eq(users.businessId, account.businessId)))
        .limit(1);
      if (!u) throw new AppException(ErrorCode.USER_NOT_FOUND);
    }
    await this.db.update(customerChats).set({customerId}).where(eq(customerChats.id, chatId));
    return this.detail(account, chatId);
  }

  async addNote(account: IAccount, chatId: string, text: string) {
    await this.chatOrThrow(account.businessId, chatId);
    await this.db.insert(customerChatNotes).values({
      id: generateId(),
      businessId: account.businessId,
      chatId,
      accountId: account.id,
      authorName: await this.accountName(account),
      text: text.trim(),
    });
    return this.detail(account, chatId);
  }

  async deleteNote(account: IAccount, noteId: string) {
    const [note] = await this.db
      .select()
      .from(customerChatNotes)
      .where(and(eq(customerChatNotes.id, noteId), eq(customerChatNotes.businessId, account.businessId)))
      .limit(1);
    if (!note) throw new AppException(ErrorCode.NOT_FOUND);
    // Your own note, or the owner tidying up.
    if (note.accountId !== account.id && account.type !== 'business') {
      throw new AppException(ErrorCode.FORBIDDEN);
    }
    await this.db.delete(customerChatNotes).where(eq(customerChatNotes.id, noteId));
  }

  /** Review of a bot answer. Only bot messages can be flagged. */
  async flagMessage(account: IAccount, messageId: string, flag: 'wrong' | null) {
    const rows = await this.db
      .update(customerChatMessages)
      .set({flag})
      .where(
        and(
          eq(customerChatMessages.id, messageId),
          eq(customerChatMessages.businessId, account.businessId),
          eq(customerChatMessages.role, 'bot'),
        ),
      )
      .returning({id: customerChatMessages.id});
    if (!rows.length) throw new AppException(ErrorCode.NOT_FOUND);
    return {id: messageId, flag};
  }

  /** "FAQ'ga qo'shish" from the inbox — same right as the Telegram button. */
  async addFaq(account: IAccount, question: string, answer: string) {
    const [row] = await this.db
      .insert(aiAssistantFaqs)
      .values({
        id: generateId(),
        businessId: account.businessId,
        question: question.trim(),
        answer: answer.trim(),
        source: 'handoff',
      })
      .returning();
    return row;
  }

  // ── Photos ─────────────────────────────────────────────────────────────────

  /** A customer's photo, fetched from Telegram on demand (never stored). */
  async media(account: IAccount, messageId: string): Promise<{bytes: Buffer; contentType: string}> {
    const [m] = await this.db
      .select({media: customerChatMessages.media})
      .from(customerChatMessages)
      .where(
        and(
          eq(customerChatMessages.id, messageId),
          eq(customerChatMessages.businessId, account.businessId),
        ),
      )
      .limit(1);
    if (!m?.media) throw new AppException(ErrorCode.NOT_FOUND);
    const token = await this.handoff.storeToken(account.businessId);
    if (!token) throw new AppException(ErrorCode.ASSISTANT_STORE_BOT_REQUIRED);
    try {
      return await this.tg.downloadFile(token, m.media.fileId);
    } catch (e) {
      this.logger.warn(`inbox media: ${(e as Error).message}`);
      throw new AppException(ErrorCode.NOT_FOUND);
    }
  }

  // ── Quick replies ──────────────────────────────────────────────────────────

  listQuickReplies(businessId: string) {
    return this.db
      .select()
      .from(assistantQuickReplies)
      .where(eq(assistantQuickReplies.businessId, businessId))
      .orderBy(asc(assistantQuickReplies.sortOrder), asc(assistantQuickReplies.createdAt));
  }

  async createQuickReply(businessId: string, title: string, text: string) {
    const [{n}] = await this.db
      .select({n: sql<number>`coalesce(max(${assistantQuickReplies.sortOrder}), -1)::int`})
      .from(assistantQuickReplies)
      .where(eq(assistantQuickReplies.businessId, businessId));
    const [row] = await this.db
      .insert(assistantQuickReplies)
      .values({id: generateId(), businessId, title: title.trim(), text: text.trim(), sortOrder: n + 1})
      .returning();
    return row;
  }

  async updateQuickReply(businessId: string, id: string, data: {title?: string; text?: string}) {
    const [row] = await this.db
      .update(assistantQuickReplies)
      .set({
        ...(data.title !== undefined ? {title: data.title.trim()} : {}),
        ...(data.text !== undefined ? {text: data.text.trim()} : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(assistantQuickReplies.id, id), eq(assistantQuickReplies.businessId, businessId)))
      .returning();
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    return row;
  }

  async deleteQuickReply(businessId: string, id: string) {
    const rows = await this.db
      .delete(assistantQuickReplies)
      .where(and(eq(assistantQuickReplies.id, id), eq(assistantQuickReplies.businessId, businessId)))
      .returning({id: assistantQuickReplies.id});
    if (!rows.length) throw new AppException(ErrorCode.NOT_FOUND);
  }

  // ── People ─────────────────────────────────────────────────────────────────

  /** Who a chat can be assigned to: the owner + active staff allowed to answer. */
  async agents(businessId: string) {
    const [biz] = await this.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    const out: {id: string; name: string; owner: boolean; telegramLinked: boolean}[] = [];
    const linked = new Set(
      (
        await this.db
          .select({id: telegramLinks.accountId})
          .from(telegramLinks)
          .where(and(eq(telegramLinks.businessId, businessId), eq(telegramLinks.isActive, true)))
      ).map((r) => r.id),
    );
    out.push({id: businessId, name: biz?.name ?? 'Ega', owner: true, telegramLinked: linked.has(businessId)});
    const members = await this.db
      .select({id: staff.id, name: staff.name, roleId: staff.roleId})
      .from(staff)
      .where(and(eq(staff.businessId, businessId), eq(staff.isActive, true), eq(staff.hasAccount, true)))
      .orderBy(asc(staff.name));
    for (const m of members) {
      const acc: IAccount = {type: 'staff', id: m.id, businessId, roleId: m.roleId ?? undefined};
      if (await this.permissions.can(acc, 'customer:chat:reply')) {
        out.push({id: m.id, name: m.name, owner: false, telegramLinked: linked.has(m.id)});
      }
    }
    return out;
  }

  private async accountNames(businessId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const [biz] = await this.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    map.set(businessId, biz?.name ?? 'Ega');
    const members = await this.db
      .select({id: staff.id, name: staff.name})
      .from(staff)
      .where(eq(staff.businessId, businessId));
    for (const m of members) map.set(m.id, m.name);
    return map;
  }

  private async accountName(account: IAccount): Promise<string> {
    return (await this.accountNames(account.businessId)).get(account.id) ?? 'Xodim';
  }

  // ── Customer card ──────────────────────────────────────────────────────────

  private async customerCard(businessId: string, customerId: string) {
    const [u] = await this.db
      .select({
        id: users.id,
        name: users.name,
        phone: users.phone,
        bonusBalance: users.bonusBalance,
        totalSpent: users.totalSpent,
      })
      .from(users)
      .where(and(eq(users.id, customerId), eq(users.businessId, businessId)))
      .limit(1);
    if (!u) return null;
    const [debt] = await this.db
      .select({
        remaining: sql<number>`coalesce(sum(${userDebts.amount}::numeric - coalesce((
          SELECT sum(p.amount) FROM ${debtPayments} p WHERE p.debt_id = ${userDebts.id}), 0)), 0)::float8`,
      })
      .from(userDebts)
      .where(
        and(eq(userDebts.businessId, businessId), eq(userDebts.userId, customerId), ne(userDebts.status, 'Paid')),
      );
    const recent = await this.db
      .select({
        id: orders.id,
        totalAmount: orders.totalAmount,
        status: orders.status,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.userId, customerId)))
      .orderBy(desc(orders.createdAt))
      .limit(5);
    return {
      id: u.id,
      name: u.name,
      phone: u.phone,
      bonusBalance: Number(u.bonusBalance),
      totalSpent: Number(u.totalSpent),
      debt: Math.max(0, debt?.remaining ?? 0),
      recentOrders: recent.map((o) => ({...o, totalAmount: Number(o.totalAmount)})),
    };
  }

  /**
   * Customers this Telegram user is probably: whoever their storefront
   * (Mini App) orders were placed for — by user id or by phone.
   */
  private async suggestCustomers(businessId: string, chat: CustomerChat) {
    if (!chat.telegramUserId) return [];
    const viaOrders = await this.db
      .selectDistinct({userId: orders.userId, phone: orders.customerPhone})
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.telegramUserId, chat.telegramUserId)))
      .limit(10);
    const ids = viaOrders.map((o) => o.userId).filter((x): x is string => !!x);
    const phones = viaOrders.map((o) => o.phone).filter((x): x is string => !!x);
    if (!ids.length && !phones.length) return [];
    return this.db
      .select({id: users.id, name: users.name, phone: users.phone})
      .from(users)
      .where(
        and(
          eq(users.businessId, businessId),
          or(
            ids.length ? inArray(users.id, ids) : undefined,
            phones.length ? inArray(users.phone, phones) : undefined,
          ),
        ),
      )
      .limit(5);
  }

  private async chatOrThrow(businessId: string, chatId: string): Promise<CustomerChat> {
    const [chat] = await this.db
      .select()
      .from(customerChats)
      .where(and(eq(customerChats.id, chatId), eq(customerChats.businessId, businessId)))
      .limit(1);
    if (!chat) throw new AppException(ErrorCode.INBOX_CHAT_NOT_FOUND);
    return chat;
  }
}


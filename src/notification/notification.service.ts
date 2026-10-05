import {Inject, Injectable, Logger} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {Cron} from '@nestjs/schedule';
import {and, desc, eq, gt, isNull, lt, lte, or, sql} from 'drizzle-orm';
import * as webpush from 'web-push';
import {DatabaseService} from '../database/database.service';
import {
  announcements,
  notifications,
  pushSubscriptions,
  PushSubscriptionRow,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {
  createdAtKeys,
  decodeCursor,
  keysetBefore,
  takePage,
} from '../common/cursor';
import {AnnouncementService} from '../announcement/announcement.service';
import {readNotificationSettings} from '../telegram/notification-settings';
import {Notice, pickLocalized, PushText, renderPush} from './push-text';

const INBOX_RETENTION_DAYS = 30;
// A push service that keeps failing (not 404/410, which delete at once) is
// given this many tries before the subscription is dropped.
const MAX_PUSH_FAILURES = 10;

interface PushPayload extends PushText {
  url: string;
  tag?: string;
  id?: string;
}

/**
 * The owner's phone notifications: the 🔔 inbox and Web Push delivery.
 *
 * Events arrive from TelegramNotifyService.dispatch after the shared toggle
 * passed, so `record` never re-checks settings. Delivery is fire-and-forget —
 * a sale, a shift close or a return must never wait on a push service.
 * Push is off (inbox still recorded) when the VAPID keys are not configured.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly publicKey: string | null;

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly announcementService: AnnouncementService,
  ) {
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    this.publicKey = pub && priv ? pub : null;
    if (pub && priv) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:support@kpos.uz',
        pub,
        priv,
      );
    }
  }

  private get db() {
    return this.dbService.db;
  }

  // ── Recording + delivery ──────────────────────────────────────────────────

  /** Write the event to the inbox and push it to the owner's phones. Never throws. */
  fire(businessId: string, notice: Notice): void {
    void this.record(businessId, notice).catch((e) =>
      this.logger.warn(`notification ${notice.event} failed: ${(e as Error).message}`),
    );
  }

  async record(businessId: string, notice: Notice): Promise<void> {
    const id = generateId();
    await this.db
      .insert(notifications)
      .values({id, businessId, event: notice.event, data: notice.data});
    await this.pushToBusiness(businessId, (locale) => ({
      ...renderPush(notice, locale),
      url: notice.data.url,
      tag: notice.event,
      id,
    }));
  }

  private async pushToBusiness(
    businessId: string,
    render: (locale: string) => PushPayload,
  ): Promise<number> {
    if (!this.publicKey) return 0;
    const subs = await this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.businessId, businessId));
    const results = await Promise.all(
      subs.map((s) => this.send(s, render(s.locale))),
    );
    return results.filter(Boolean).length;
  }

  private async send(sub: PushSubscriptionRow, payload: PushPayload): Promise<boolean> {
    try {
      await webpush.sendNotification(
        {endpoint: sub.endpoint, keys: {p256dh: sub.p256dh, auth: sub.auth}},
        JSON.stringify(payload),
        {TTL: 24 * 3600},
      );
      if (sub.failureCount > 0 || !sub.lastSuccessAt) {
        await this.db
          .update(pushSubscriptions)
          .set({failureCount: 0, lastSuccessAt: new Date()})
          .where(eq(pushSubscriptions.id, sub.id));
      }
      return true;
    } catch (e) {
      const status = (e as {statusCode?: number}).statusCode;
      // 404/410: the browser unsubscribed or the app was removed — for good.
      if (status === 404 || status === 410 || sub.failureCount + 1 >= MAX_PUSH_FAILURES) {
        await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
      } else {
        await this.db
          .update(pushSubscriptions)
          .set({failureCount: sub.failureCount + 1})
          .where(eq(pushSubscriptions.id, sub.id));
      }
      this.logger.warn(`push → ${sub.id} failed (${status ?? '?'}): ${(e as Error).message}`);
      return false;
    }
  }

  // ── Inbox ─────────────────────────────────────────────────────────────────

  async list(businessId: string, opts: {cursor?: string; limit?: number}) {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const keys = createdAtKeys(notifications.createdAt, notifications.id);
    const cursor = decodeCursor(opts.cursor, keys.length);
    const rows = await this.db
      .select({
        id: notifications.id,
        event: notifications.event,
        data: notifications.data,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.businessId, businessId),
          ...(cursor ? [keysetBefore(keys, cursor)] : []),
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);
    const page = takePage(rows, limit, keys);
    return {
      items: page.rows,
      unread: await this.unreadCount(businessId),
      nextCursor: page.nextCursor,
    };
  }

  async unreadCount(businessId: string): Promise<number> {
    const [row] = await this.db
      .select({count: sql<number>`COUNT(*)::int`})
      .from(notifications)
      .where(and(eq(notifications.businessId, businessId), isNull(notifications.readAt)));
    return Number(row?.count ?? 0);
  }

  async markRead(businessId: string, id: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({readAt: new Date()})
      .where(
        and(
          eq(notifications.businessId, businessId),
          eq(notifications.id, id),
          isNull(notifications.readAt),
        ),
      );
  }

  async markAllRead(businessId: string): Promise<{updated: number}> {
    const rows = await this.db
      .update(notifications)
      .set({readAt: new Date()})
      .where(and(eq(notifications.businessId, businessId), isNull(notifications.readAt)))
      .returning({id: notifications.id});
    return {updated: rows.length};
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  config(): {enabled: boolean; publicKey: string | null} {
    return {enabled: this.publicKey != null, publicKey: this.publicKey};
  }

  /**
   * Save this phone's push endpoint. An endpoint is one browser install; if it
   * was registered by another business (the phone logged into a different
   * shop), it moves to this one.
   */
  async subscribe(
    businessId: string,
    sub: {endpoint: string; keys: {p256dh: string; auth: string}; locale?: string},
    userAgent?: string,
  ): Promise<void> {
    const now = new Date();
    const values = {
      businessId,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      locale: sub.locale === 'ru' ? 'ru' : 'uz',
      userAgent: userAgent?.slice(0, 500) ?? null,
      failureCount: 0,
      updatedAt: now,
    };
    await this.db
      .insert(pushSubscriptions)
      .values({id: generateId(), endpoint: sub.endpoint, ...values})
      .onConflictDoUpdate({target: pushSubscriptions.endpoint, set: values});
  }

  async unsubscribe(businessId: string, endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.businessId, businessId),
          eq(pushSubscriptions.endpoint, endpoint),
        ),
      );
  }

  /** "Sinab ko'rish": push to every phone of the business, no inbox row. */
  async test(businessId: string): Promise<{sent: number}> {
    const notice: Notice = {event: 'test', data: {url: '/more/notifications'}};
    const sent = await this.pushToBusiness(businessId, (locale) => ({
      ...renderPush(notice, locale),
      url: notice.data.url,
      tag: 'test',
    }));
    return {sent};
  }

  // ── Scheduled ─────────────────────────────────────────────────────────────

  @Cron('30 3 * * *', {name: 'notifications-prune', timeZone: 'Asia/Tashkent'})
  async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - INBOX_RETENTION_DAYS * 86_400_000);
    try {
      await this.db.delete(notifications).where(lt(notifications.createdAt, cutoff));
    } catch (e) {
      this.logger.warn(`inbox prune failed: ${(e as Error).message}`);
    }
  }

  /**
   * Push announcements that went live since the last run (scheduled ones
   * included) to every owner phone in their audience. Stamped before sending,
   * so an overlapping or failed run never pushes the same one twice.
   */
  @Cron('*/5 * * * *', {name: 'announcements-push'})
  async pushAnnouncements(): Promise<void> {
    if (!this.publicKey) return;
    try {
      const now = new Date();
      const due = await this.db
        .update(announcements)
        .set({pushedAt: now})
        .where(
          and(
            isNull(announcements.pushedAt),
            lte(announcements.publishedAt, now),
            or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)),
          ),
        )
        .returning({
          id: announcements.id,
          title: announcements.title,
          body: announcements.body,
        });
      if (!due.length) return;

      const businessIds = await this.db
        .selectDistinct({businessId: pushSubscriptions.businessId})
        .from(pushSubscriptions);
      for (const {businessId} of businessIds) {
        const settings = await readNotificationSettings(this.dbService, this.cache, businessId);
        if (!settings.announcements) continue;
        const visible = new Set(
          await this.announcementService.visibleIds(businessId, due.map((a) => a.id)),
        );
        for (const a of due) {
          if (!visible.has(a.id)) continue;
          await this.pushToBusiness(businessId, (locale) => ({
            title: `📢 ${pickLocalized(a.title, locale)}`,
            body: pickLocalized(a.body, locale).replace(/\s+/g, ' ').slice(0, 160),
            url: '/notifications',
            tag: `announcement-${a.id}`,
          }));
        }
      }
    } catch (e) {
      this.logger.warn(`announcement push failed: ${(e as Error).message}`);
    }
  }
}

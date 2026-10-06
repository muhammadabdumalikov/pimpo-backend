import {Logger} from '@nestjs/common';
import {Cache} from '@nestjs/cache-manager';
import {eq} from 'drizzle-orm';
import {
  telegramNotificationSettings,
  TelegramNotificationSettings,
} from '../database/schema';
import {CacheKeys, TTL} from '../cache/cache.util';
import {DatabaseService} from '../database/database.service';

/**
 * The notification toggles — one list for both channels (Telegram chats and
 * the owner's phone push). Matches the boolean columns of the settings table.
 */
export type NotifyToggle =
  | 'checkout'
  | 'cashShifts'
  | 'cashOperations'
  | 'dailySales'
  | 'onlineOrders'
  | 'suspicious'
  | 'lowStock'
  | 'announcements';

export const NOTIFY_TOGGLES: NotifyToggle[] = [
  'checkout',
  'cashShifts',
  'cashOperations',
  'dailySales',
  'onlineOrders',
  'suspicious',
  'lowStock',
  'announcements',
];

/**
 * Defaults for a business that never saved settings. The chatty per-event
 * toggles that predate the phone UI stay opt-in; the daily digest and the
 * rare, wanted phone events are on.
 */
export function defaultNotificationSettings(
  businessId: string,
): TelegramNotificationSettings {
  return {
    businessId,
    checkout: false,
    cashShifts: false,
    cashOperations: false,
    dailySales: true,
    onlineOrders: true,
    suspicious: true,
    lowStock: true,
    announcements: true,
    updatedAt: new Date(),
  };
}

const logger = new Logger('NotificationSettings');

/**
 * The business's toggles (cached, write-invalidated on the settings PUT).
 * Fails open to the defaults if the table is unmigrated or the DB is
 * momentarily unreachable — event delivery must never throw on it.
 */
export function readNotificationSettings(
  dbService: DatabaseService,
  cache: Cache,
  businessId: string,
): Promise<TelegramNotificationSettings> {
  return cache.wrap(
    CacheKeys.telegramSettings(businessId),
    async () => {
      try {
        const [row] = await dbService.db
          .select()
          .from(telegramNotificationSettings)
          .where(eq(telegramNotificationSettings.businessId, businessId))
          .limit(1);
        return row ?? defaultNotificationSettings(businessId);
      } catch (e) {
        logger.warn(`settings read failed → defaults: ${(e as Error).message}`);
        return defaultNotificationSettings(businessId);
      }
    },
    TTL.TELEGRAM_SETTINGS,
  );
}

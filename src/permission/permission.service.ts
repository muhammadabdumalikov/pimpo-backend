import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {roles} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {CacheKeys, TTL} from '../cache/cache.util';
import {IAccount} from '../business/types';
import {ALL_PERMISSIONS} from './permission.catalog';

/** Per-role permission list, cached under its own key (small, hot, read-only). */
type Cached = {permissions: string[]};

/**
 * Resolves the ACTION permissions behind the acting account, and asserts them.
 *
 * Where the data lives — and why it is NOT in the JWT: tokens last 7 days and
 * there is no revocation list, so a permission baked into a token would keep
 * working for a week after the owner took it away. The token carries identity
 * (roleId); the rights are read per request, through three layers:
 *
 *   L1  in-process Map, 10s   — only a shield: while Redis is down cache.wrap
 *                               falls through to Postgres on EVERY request, and
 *                               a per-request DB hit would starve a pool of 10.
 *   L2  Redis, TTL.ROLES      — shared across instances, write-invalidated.
 *   L3  Postgres              — source of truth.
 *
 * L1 is per process, so a role edited on another instance would be stale there
 * for up to 10s; that is the price of the outage shield and the reason the TTL
 * is seconds, not minutes.
 */
@Injectable()
export class PermissionService {
  private static readonly L1_TTL_MS = 10_000;
  private readonly l1 = new Map<string, {value: string[]; until: number}>();

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Permissions of the acting account. Owner holds the `*` sentinel. */
  async resolve(account: IAccount): Promise<string[]> {
    if (account.type === 'business') return [ALL_PERMISSIONS];
    if (account.permissions) return account.permissions; // per-request memo
    if (!account.roleId || !account.businessId) return [];

    const permissions = await this.forRole(account.businessId, account.roleId);
    account.permissions = permissions;
    return permissions;
  }

  /** True when the account may perform every one of `required`. */
  async can(account: IAccount, ...required: string[]): Promise<boolean> {
    if (!required.length) return true;
    const held = await this.resolve(account);
    if (held.includes(ALL_PERMISSIONS)) return true;
    return required.every((perm) => held.includes(perm));
  }

  /**
   * Throws PERMISSION_DENIED unless the account holds every listed permission.
   * Use this inside a service when the required permission depends on the
   * payload (e.g. creating a receipt only needs `receipt:receive` when it is
   * NOT a draft) — the decorator can't see the body, this can.
   */
  async assert(account: IAccount, ...required: string[]): Promise<void> {
    if (await this.can(account, ...required)) return;
    const held = await this.resolve(account);
    const missing = required.filter((perm) => !held.includes(perm));
    throw new AppException(ErrorCode.PERMISSION_DENIED, {
      required: missing.join(', '),
    });
  }

  /**
   * Guards against privilege escalation: a non-owner may only hand out
   * permissions they hold themselves. Without this, anyone granted
   * `role:manage` or `staff:manage` could mint a role with every right and
   * assign it — turning a delegated power into a way to become the owner.
   *
   * The owner holds '*' and passes unconditionally.
   */
  async assertCanGrant(
    account: IAccount,
    granting: string[],
  ): Promise<void> {
    if (!granting.length) return;
    const held = await this.resolve(account);
    if (held.includes(ALL_PERMISSIONS)) return;
    const excess = granting.filter((perm) => !held.includes(perm));
    if (excess.length) {
      throw new AppException(ErrorCode.PERMISSION_GRANT_EXCEEDS_OWN, {
        excess: excess.join(', '),
      });
    }
  }

  /** Drops the L1 entries of a business. Call alongside the Redis del. */
  invalidate(businessId: string): void {
    const prefix = `${businessId}:`;
    for (const key of this.l1.keys()) {
      if (key.startsWith(prefix)) this.l1.delete(key);
    }
  }

  private async forRole(
    businessId: string,
    roleId: string,
  ): Promise<string[]> {
    const key = `${businessId}:${roleId}`;
    const hit = this.l1.get(key);
    if (hit && hit.until > Date.now()) return hit.value;

    const cached = await this.cache.wrap<Cached>(
      CacheKeys.rolePermissions(businessId, roleId),
      async () => {
        const [role] = await this.dbService.db
          .select({
            permissions: roles.permissions,
            isActive: roles.isActive,
          })
          .from(roles)
          .where(and(eq(roles.businessId, businessId), eq(roles.id, roleId)))
          .limit(1);
        // An inactive or deleted role grants nothing. The session itself is
        // invalidated on the next /businesses/me/account refresh.
        if (!role || !role.isActive) return {permissions: []};
        return {permissions: role.permissions ?? []};
      },
      TTL.ROLES,
    );

    const value = cached?.permissions ?? [];
    this.l1.set(key, {value, until: Date.now() + PermissionService.L1_TTL_MS});
    return value;
  }
}

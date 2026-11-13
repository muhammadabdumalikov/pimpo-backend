import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {branches, staff} from '../database/schema';
import {CacheKeys} from '../cache/cache.util';
import {IAccount} from '../business/types';
import {PermissionService} from './permission.service';

/** Short: a move between branches takes effect within a minute. */
const STAFF_BRANCH_TTL_MS = 60_000;

/**
 * Which branch an account may read. `null` = every branch (the owner, or a
 * staff role with `branch:all`); otherwise the one branch it is pinned to —
 * its own staff.branch_id, or the default branch when none is assigned.
 */
@Injectable()
export class BranchScopeService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly permissions: PermissionService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async scopeFor(account: IAccount): Promise<string | null> {
    if (account.type === 'business') return null;
    if (await this.permissions.can(account, 'branch:all')) return null;
    return this.pinnedBranch(account);
  }

  /** Drop the cached branch of one staff account (after an edit). */
  async invalidate(businessId: string, staffId: string): Promise<void> {
    await this.cache.del(CacheKeys.staffBranch(businessId, staffId));
  }

  private async pinnedBranch(account: IAccount): Promise<string | null> {
    const cached = await this.cache.wrap<{branchId: string | null}>(
      CacheKeys.staffBranch(account.businessId, account.id),
      async () => {
        const [row] = await this.dbService.db
          .select({branchId: staff.branchId})
          .from(staff)
          .where(
            and(
              eq(staff.businessId, account.businessId),
              eq(staff.id, account.id),
            ),
          )
          .limit(1);
        if (row?.branchId) return {branchId: row.branchId};
        const [def] = await this.dbService.db
          .select({id: branches.id})
          .from(branches)
          .where(
            and(
              eq(branches.businessId, account.businessId),
              eq(branches.isDefault, true),
            ),
          )
          .limit(1);
        return {branchId: def?.id ?? null};
      },
      STAFF_BRANCH_TTL_MS,
    );
    // A business with no branch row yet has nothing to narrow to; every read
    // already returns that single store.
    return cached?.branchId ?? null;
  }
}

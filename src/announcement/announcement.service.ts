import {Injectable} from '@nestjs/common';
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  announcementReads,
  announcements,
  announcementTargets,
  businesses,
  type Announcement,
  type LocalizedText,
} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {SubscriptionService} from '../subscription/subscription.service';
import {TIER_RANK, type Tier} from '../subscription/tier';
import {FeatureService} from '../feature/feature.service';
import {findFeature} from '../feature/feature.catalog';
import {
  TENANT_ANNOUNCEMENT_LIMIT,
  type AnnouncementAudience,
  type AnnouncementStatus,
} from './announcement.constants';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

/** What the in-app bell gets — no audience internals. */
export interface TenantAnnouncement {
  id: string;
  kind: string;
  title: LocalizedText;
  body: LocalizedText;
  linkUrl: string | null;
  popup: boolean;
  publishedAt: Date;
  read: boolean;
}

export interface PlatformAnnouncementRow extends Announcement {
  status: AnnouncementStatus;
  targetCount: number;
  /** Shops where at least one account has opened it. */
  readBusinessCount: number;
}

export interface PlatformAnnouncementDetail extends PlatformAnnouncementRow {
  targets: {id: string; name: string; login: string}[];
}

/**
 * "Yangiliklar": release notes and notices written in the platform console and
 * shown in the app's bell (or as a popup). Each one is aimed at an audience —
 * every shop, a plan tier and up, a hand-picked list, or the shops a feature
 * flag is on for (so a beta's release note reaches exactly its beta shops).
 */
@Injectable()
export class AnnouncementService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
    private readonly featureService: FeatureService,
  ) {}

  // ── Tenant side ────────────────────────────────────────────────────────────

  async listForAccount(
    businessId: string,
    account: IAccount,
  ): Promise<{items: TenantAnnouncement[]; unread: number}> {
    const visible = await this.visibleTo(businessId);
    const rows = await this.dbService.db
      .select({
        id: announcements.id,
        kind: announcements.kind,
        title: announcements.title,
        body: announcements.body,
        linkUrl: announcements.linkUrl,
        popup: announcements.popup,
        publishedAt: announcements.publishedAt,
        readAt: announcementReads.readAt,
      })
      .from(announcements)
      .leftJoin(
        announcementReads,
        and(
          eq(announcementReads.announcementId, announcements.id),
          eq(announcementReads.accountId, account.id),
        ),
      )
      .where(visible)
      .orderBy(desc(announcements.publishedAt))
      .limit(TENANT_ANNOUNCEMENT_LIMIT);

    const items = rows.map(({readAt, publishedAt, ...rest}) => ({
      ...rest,
      // visibleTo() only passes published rows.
      publishedAt: publishedAt!,
      read: readAt != null,
    }));
    return {items, unread: items.filter((i) => !i.read).length};
  }

  async markRead(
    businessId: string,
    account: IAccount,
    id: string,
  ): Promise<void> {
    const [row] = await this.dbService.db
      .select({id: announcements.id})
      .from(announcements)
      .where(and(eq(announcements.id, id), await this.visibleTo(businessId)))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.ANNOUNCEMENT_NOT_FOUND);

    await this.dbService.db
      .insert(announcementReads)
      .values({announcementId: id, accountId: account.id, businessId})
      .onConflictDoNothing();
  }

  async markAllRead(
    businessId: string,
    account: IAccount,
  ): Promise<{updated: number}> {
    const {items} = await this.listForAccount(businessId, account);
    const unread = items.filter((i) => !i.read);
    if (!unread.length) return {updated: 0};
    await this.dbService.db
      .insert(announcementReads)
      .values(
        unread.map((i) => ({
          announcementId: i.id,
          accountId: account.id,
          businessId,
        })),
      )
      .onConflictDoNothing();
    return {updated: unread.length};
  }

  /** Published, not expired, and aimed at this business. */
  private async visibleTo(businessId: string): Promise<SQL> {
    const now = new Date();
    const [tier, features] = await Promise.all([
      this.subscriptionService.getEffectiveTier(businessId),
      this.featureService.enabledFor(businessId),
    ]);
    const tiersReached = (Object.keys(TIER_RANK) as Tier[]).filter(
      (t) => TIER_RANK[t] <= TIER_RANK[tier],
    );

    const audience: SQL[] = [
      eq(announcements.audience, 'all'),
      and(
        eq(announcements.audience, 'tier'),
        inArray(announcements.minTier, tiersReached),
      )!,
      and(
        eq(announcements.audience, 'selected'),
        exists(
          this.dbService.db
            .select({one: sql`1`})
            .from(announcementTargets)
            .where(
              and(
                eq(announcementTargets.announcementId, announcements.id),
                eq(announcementTargets.businessId, businessId),
              ),
            ),
        ),
      )!,
    ];
    if (features.length) {
      audience.push(
        and(
          eq(announcements.audience, 'feature'),
          inArray(announcements.featureKey, features),
        )!,
      );
    }

    return and(
      isNotNull(announcements.publishedAt),
      lte(announcements.publishedAt, now),
      or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)),
      or(...audience),
    )!;
  }

  // ── Platform console ───────────────────────────────────────────────────────

  async listForPlatform(): Promise<PlatformAnnouncementRow[]> {
    const db = this.dbService.db;
    const [rows, targetCounts, readCounts] = await Promise.all([
      db.select().from(announcements).orderBy(desc(announcements.createdAt)),
      db
        .select({id: announcementTargets.announcementId, n: count()})
        .from(announcementTargets)
        .groupBy(announcementTargets.announcementId),
      db
        .select({
          id: announcementReads.announcementId,
          n: countDistinct(announcementReads.businessId),
        })
        .from(announcementReads)
        .groupBy(announcementReads.announcementId),
    ]);
    const targetsOf = new Map(targetCounts.map((c) => [c.id, c.n]));
    const readsOf = new Map(readCounts.map((c) => [c.id, c.n]));
    const now = Date.now();
    return rows.map((row) => ({
      ...row,
      status: statusOf(row, now),
      targetCount: targetsOf.get(row.id) ?? 0,
      readBusinessCount: readsOf.get(row.id) ?? 0,
    }));
  }

  async getForPlatform(id: string): Promise<PlatformAnnouncementDetail> {
    const db = this.dbService.db;
    const [row] = await db
      .select()
      .from(announcements)
      .where(eq(announcements.id, id))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.ANNOUNCEMENT_NOT_FOUND);

    const [targets, [{n: readBusinessCount}]] = await Promise.all([
      db
        .select({
          id: businesses.id,
          name: businesses.name,
          login: businesses.login,
        })
        .from(announcementTargets)
        .innerJoin(
          businesses,
          eq(businesses.id, announcementTargets.businessId),
        )
        .where(eq(announcementTargets.announcementId, id))
        .orderBy(asc(businesses.name)),
      db
        .select({n: countDistinct(announcementReads.businessId)})
        .from(announcementReads)
        .where(eq(announcementReads.announcementId, id)),
    ]);
    return {
      ...row,
      status: statusOf(row, Date.now()),
      targetCount: targets.length,
      readBusinessCount,
      targets,
    };
  }

  async create(
    dto: CreateAnnouncementDto,
  ): Promise<PlatformAnnouncementDetail> {
    const audience = dto.audience;
    const minTier = audience === 'tier' ? (dto.minTier ?? null) : null;
    const featureKey = audience === 'feature' ? (dto.featureKey ?? null) : null;
    const targetIds =
      audience === 'selected' ? [...new Set(dto.businessIds ?? [])] : [];
    this.assertAudience(audience, minTier, featureKey, targetIds);
    await this.assertBusinessesExist(targetIds);

    const id = generateId();
    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(announcements).values({
        id,
        kind: dto.kind ?? 'feature',
        title: dto.title,
        body: dto.body,
        linkUrl: dto.linkUrl ?? null,
        audience,
        minTier,
        featureKey,
        popup: dto.popup ?? false,
        publishedAt: toDate(dto.publishedAt),
        expiresAt: toDate(dto.expiresAt),
      });
      if (targetIds.length) {
        await tx
          .insert(announcementTargets)
          .values(
            targetIds.map((businessId) => ({announcementId: id, businessId})),
          );
      }
    });
    return this.getForPlatform(id);
  }

  async update(
    id: string,
    dto: UpdateAnnouncementDto,
  ): Promise<PlatformAnnouncementDetail> {
    const current = await this.getForPlatform(id);

    // Resolve the audience as it will stand after this update, then keep only
    // the fields that audience uses — a stale min_tier or target list left
    // behind an audience switch would silently come back if it switched again.
    const audience = dto.audience ?? (current.audience as AnnouncementAudience);
    const minTier =
      audience === 'tier'
        ? dto.minTier !== undefined
          ? dto.minTier
          : current.minTier
        : null;
    const featureKey =
      audience === 'feature'
        ? dto.featureKey !== undefined
          ? dto.featureKey
          : current.featureKey
        : null;
    const targetIds =
      audience === 'selected'
        ? dto.businessIds !== undefined
          ? [...new Set(dto.businessIds)]
          : current.targets.map((t) => t.id)
        : [];
    this.assertAudience(audience, minTier, featureKey, targetIds);
    await this.assertBusinessesExist(targetIds);

    const set: Partial<typeof announcements.$inferInsert> = {
      audience,
      minTier,
      featureKey,
      updatedAt: new Date(),
    };
    if (dto.kind) set.kind = dto.kind;
    if (dto.title) set.title = dto.title;
    if (dto.body) set.body = dto.body;
    if (dto.linkUrl !== undefined) set.linkUrl = dto.linkUrl;
    if (dto.popup !== undefined && dto.popup !== null) set.popup = dto.popup;
    if (dto.publishedAt !== undefined)
      set.publishedAt = toDate(dto.publishedAt);
    if (dto.expiresAt !== undefined) set.expiresAt = toDate(dto.expiresAt);

    await this.dbService.db.transaction(async (tx) => {
      await tx.update(announcements).set(set).where(eq(announcements.id, id));
      await tx
        .delete(announcementTargets)
        .where(eq(announcementTargets.announcementId, id));
      if (targetIds.length) {
        await tx
          .insert(announcementTargets)
          .values(
            targetIds.map((businessId) => ({announcementId: id, businessId})),
          );
      }
    });
    return this.getForPlatform(id);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.dbService.db
      .delete(announcements)
      .where(eq(announcements.id, id))
      .returning({id: announcements.id});
    if (!deleted.length)
      throw new AppException(ErrorCode.ANNOUNCEMENT_NOT_FOUND);
  }

  private assertAudience(
    audience: AnnouncementAudience,
    minTier: string | null,
    featureKey: string | null,
    targetIds: string[],
  ): void {
    if (audience === 'tier' && !minTier) {
      throw new AppException(ErrorCode.ANNOUNCEMENT_AUDIENCE_INVALID, {
        audience,
        field: 'minTier',
      });
    }
    if (audience === 'feature') {
      if (!featureKey) {
        throw new AppException(ErrorCode.ANNOUNCEMENT_AUDIENCE_INVALID, {
          audience,
          field: 'featureKey',
        });
      }
      if (!findFeature(featureKey)) {
        throw new AppException(ErrorCode.FEATURE_NOT_FOUND, {
          feature: featureKey,
        });
      }
    }
    if (audience === 'selected' && !targetIds.length) {
      throw new AppException(ErrorCode.ANNOUNCEMENT_AUDIENCE_INVALID, {
        audience,
        field: 'businessIds',
      });
    }
  }

  private async assertBusinessesExist(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const found = await this.dbService.db
      .select({id: businesses.id})
      .from(businesses)
      .where(inArray(businesses.id, ids));
    if (found.length !== ids.length) {
      throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
    }
  }
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function statusOf(
  row: Pick<Announcement, 'publishedAt' | 'expiresAt'>,
  now: number,
): AnnouncementStatus {
  if (!row.publishedAt) return 'draft';
  if (row.publishedAt.getTime() > now) return 'scheduled';
  if (row.expiresAt && row.expiresAt.getTime() <= now) return 'expired';
  return 'live';
}

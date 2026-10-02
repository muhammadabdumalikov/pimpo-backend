import {CACHE_MANAGER} from '@nestjs/cache-manager';
import {Inject, Injectable} from '@nestjs/common';
import {Cache} from 'cache-manager';
import {createHash, randomBytes} from 'crypto';
import {and, asc, desc, eq, isNotNull, isNull, or, sql} from 'drizzle-orm';
import {AuthService} from '../business/auth.service';
import {BusinessService} from '../business/business.service';
import {IAccount} from '../business/types';
import {CacheKeys, TTL} from '../cache/cache.util';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DatabaseService} from '../database/database.service';
import {
  branches,
  cashRegisters,
  devices,
  staff,
  type Device,
} from '../database/schema';
import {SubscriptionService} from '../subscription/subscription.service';
import {tierAtLeast} from '../subscription/tier';
import {verifyPin} from '../utils/pin';
import {generateId} from '../utils/uuid';
import type {DeviceStaffTile, DeviceStatus, DeviceView} from './device.types';

/** Wrong PINs allowed per (device, employee) before the till locks them out. */
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;
/** lastSeenAt is a "still alive" signal, not an audit log — one write a minute. */
const SEEN_WRITE_INTERVAL_MS = 60 * 1000;

interface PinAttempts {
  count: number;
  lockedUntil: number | null;
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class DeviceService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly businessService: BusinessService,
    private readonly authService: AuthService,
    private readonly subscriptionService: SubscriptionService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * Bind this PC to a register (DESKTOP.md Q6). Binding a register that
   * already has a live device revokes that one: a till that was reinstalled or
   * replaced must not leave its predecessor able to sign cashiers in.
   * Returns the raw token exactly once — only its hash is stored.
   */
  async bind(
    businessId: string,
    account: IAccount,
    data: {registerId: string; name: string},
  ): Promise<{token: string; device: DeviceView}> {
    const [register] = await this.db
      .select()
      .from(cashRegisters)
      .where(
        and(
          eq(cashRegisters.businessId, businessId),
          eq(cashRegisters.id, data.registerId),
          eq(cashRegisters.isActive, true),
        ),
      )
      .limit(1);
    if (!register) {
      throw new AppException(ErrorCode.DEVICE_REGISTER_NOT_FOUND);
    }

    const token = randomBytes(32).toString('base64url');
    const id = generateId();

    await this.db.transaction(async (tx) => {
      // Serialises binds within one business, so two tills bound at the same
      // moment cannot both read K3 as the next free prefix.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'devices:' + businessId}))`,
      );

      await tx
        .update(devices)
        .set({revokedAt: new Date(), updatedAt: new Date()})
        .where(
          and(eq(devices.registerId, register.id), isNull(devices.revokedAt)),
        );

      // Prefixes are never reused, revoked devices included: a receipt printed
      // offline as K2-000042 must keep pointing at one till forever.
      const used = await tx
        .select({prefix: devices.receiptPrefix})
        .from(devices)
        .where(eq(devices.businessId, businessId));
      const next =
        used.reduce((max, {prefix}) => {
          const n = /^K(\d+)$/.exec(prefix);
          return n ? Math.max(max, Number(n[1])) : max;
        }, 0) + 1;

      await tx.insert(devices).values({
        id,
        businessId,
        registerId: register.id,
        branchId: register.branchId,
        name: data.name,
        receiptPrefix: `K${next}`,
        tokenHash: hashDeviceToken(token),
        createdBy: account.id,
      });
    });

    return {token, device: await this.findView(businessId, id)};
  }

  /** Live devices first, then the revoked ones, newest first within each. */
  list(businessId: string): Promise<DeviceView[]> {
    return this.selectViews()
      .where(eq(devices.businessId, businessId))
      .orderBy(sql`${devices.revokedAt} IS NOT NULL`, desc(devices.createdAt));
  }

  async revoke(businessId: string, id: string): Promise<void> {
    const [row] = await this.db
      .update(devices)
      .set({revokedAt: new Date(), updatedAt: new Date()})
      .where(
        and(
          eq(devices.businessId, businessId),
          eq(devices.id, id),
          isNull(devices.revokedAt),
        ),
      )
      .returning({id: devices.id});
    if (!row) {
      // Already revoked is fine; a device of another business is not.
      const [exists] = await this.db
        .select({id: devices.id})
        .from(devices)
        .where(and(eq(devices.businessId, businessId), eq(devices.id, id)))
        .limit(1);
      if (!exists) throw new AppException(ErrorCode.DEVICE_NOT_FOUND);
    }
  }

  /**
   * Resolve a device token for DeviceAuthGuard. Also records that the till is
   * alive and which version it runs, at most once a minute.
   */
  async authenticate(token: string, appVersion?: string): Promise<Device> {
    const [device] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, hashDeviceToken(token)))
      .limit(1);
    if (!device) throw new AppException(ErrorCode.DEVICE_TOKEN_INVALID);
    if (device.revokedAt) throw new AppException(ErrorCode.DEVICE_REVOKED);

    const business = await this.businessService.findById(device.businessId);
    if (!business || !business.isActive) {
      throw new AppException(ErrorCode.BUSINESS_INACTIVE);
    }

    const version = appVersion?.slice(0, 32) || device.appVersion;
    const stale =
      !device.lastSeenAt ||
      Date.now() - device.lastSeenAt.getTime() > SEEN_WRITE_INTERVAL_MS;
    if (stale || version !== device.appVersion) {
      const now = new Date();
      await this.db
        .update(devices)
        .set({lastSeenAt: now, appVersion: version})
        .where(eq(devices.id, device.id));
      device.lastSeenAt = now;
      device.appVersion = version;
    }
    return device;
  }

  async status(device: Device): Promise<DeviceStatus> {
    const business = await this.businessService.findById(device.businessId);
    if (!business) throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
    const tier = await this.subscriptionService.getEffectiveTier(business.id);
    return {
      device: await this.findView(device.businessId, device.id),
      business: {id: business.id, name: business.name},
      tier,
      offlineEnabled: tierAtLeast(tier, 'proplus'),
      minDesktopVersion: process.env.MIN_DESKTOP_VERSION || '0.0.0',
      serverTime: new Date(),
    };
  }

  /**
   * Who may sign in on this till: active account holders of the device's
   * branch, plus those not tied to any branch. Employees without a PIN are
   * listed too (disabled on the till) so the owner sees who still needs one.
   */
  async staffFor(device: Device): Promise<DeviceStaffTile[]> {
    const rows = await this.db
      .select({
        id: staff.id,
        name: staff.name,
        avatarUrl: staff.avatarUrl,
        position: staff.position,
        pinHash: staff.pinHash,
      })
      .from(staff)
      .where(
        and(
          eq(staff.businessId, device.businessId),
          eq(staff.isActive, true),
          eq(staff.hasAccount, true),
          isNotNull(staff.roleId),
          device.branchId
            ? or(isNull(staff.branchId), eq(staff.branchId, device.branchId))
            : undefined,
        ),
      )
      .orderBy(asc(staff.name));

    return rows.map(({pinHash, ...tile}) => ({...tile, hasPin: !!pinHash}));
  }

  /** PIN sign-in on a bound till → an ordinary staff session (JWT). */
  async createSession(device: Device, staffId: string, pin: string) {
    const key = CacheKeys.devicePinAttempts(device.id, staffId);
    const attempts = (await this.cache.get<PinAttempts>(key)) ?? {
      count: 0,
      lockedUntil: null,
    };
    if (attempts.lockedUntil && attempts.lockedUntil > Date.now()) {
      throw new AppException(ErrorCode.PIN_LOCKED, {
        retryAfterSec: Math.ceil((attempts.lockedUntil - Date.now()) / 1000),
      });
    }

    const [member] = await this.db
      .select()
      .from(staff)
      .where(
        and(eq(staff.businessId, device.businessId), eq(staff.id, staffId)),
      )
      .limit(1);
    // Same rule as the sign-in list: someone not offered on this till cannot
    // sign in on it either.
    const offered =
      !!member &&
      (!device.branchId ||
        !member.branchId ||
        member.branchId === device.branchId);
    if (!member || !offered) throw new AppException(ErrorCode.STAFF_NOT_FOUND);
    if (!member.isActive) throw new AppException(ErrorCode.STAFF_INACTIVE);
    if (!member.hasAccount || !member.roleId) {
      throw new AppException(ErrorCode.STAFF_NO_ACCOUNT);
    }
    if (!member.pinHash) throw new AppException(ErrorCode.PIN_NOT_SET);

    if (!(await verifyPin(pin, member.pinHash))) {
      const count = attempts.count + 1;
      if (count >= PIN_MAX_ATTEMPTS) {
        const lockedUntil = Date.now() + PIN_LOCK_MS;
        await this.cache.set(
          key,
          {count: 0, lockedUntil} satisfies PinAttempts,
          TTL.DEVICE_PIN_ATTEMPTS,
        );
        throw new AppException(ErrorCode.PIN_LOCKED, {
          retryAfterSec: Math.ceil(PIN_LOCK_MS / 1000),
        });
      }
      await this.cache.set(
        key,
        {count, lockedUntil: null} satisfies PinAttempts,
        TTL.DEVICE_PIN_ATTEMPTS,
      );
      throw new AppException(ErrorCode.PIN_INVALID, {
        attemptsLeft: PIN_MAX_ATTEMPTS - count,
      });
    }

    await this.cache.del(key);
    return this.authService.buildStaffSession(member);
  }

  private selectViews() {
    return this.db
      .select({
        id: devices.id,
        name: devices.name,
        receiptPrefix: devices.receiptPrefix,
        registerId: devices.registerId,
        registerName: cashRegisters.name,
        branchId: devices.branchId,
        branchName: branches.name,
        appVersion: devices.appVersion,
        lastSeenAt: devices.lastSeenAt,
        revokedAt: devices.revokedAt,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .innerJoin(cashRegisters, eq(devices.registerId, cashRegisters.id))
      .leftJoin(branches, eq(devices.branchId, branches.id))
      .$dynamic();
  }

  private async findView(businessId: string, id: string): Promise<DeviceView> {
    const [view] = await this.selectViews()
      .where(and(eq(devices.businessId, businessId), eq(devices.id, id)))
      .limit(1);
    if (!view) throw new AppException(ErrorCode.DEVICE_NOT_FOUND);
    return view;
  }
}

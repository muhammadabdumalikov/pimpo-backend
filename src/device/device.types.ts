import {Request} from 'express';
import type {Device} from '../database/schema';
import type {Tier} from '../subscription/tier';

/** A bound till as the dashboard and the desktop app see it. */
export interface DeviceView {
  id: string;
  name: string;
  receiptPrefix: string;
  registerId: string;
  registerName: string;
  branchId: string | null;
  branchName: string | null;
  appVersion: string | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** `GET /devices/me` — what the till needs to decide how to start. */
export interface DeviceStatus {
  device: DeviceView;
  business: {id: string; name: string};
  tier: Tier;
  /** Offline selling is a Biznes+ (proplus) feature — DESKTOP.md Q14. */
  offlineEnabled: boolean;
  /** Below this the till must update before it signs anyone in (Q12). */
  minDesktopVersion: string;
  serverTime: Date;
}

/** One tile on the till's sign-in screen. */
export interface DeviceStaffTile {
  id: string;
  name: string;
  avatarUrl: string | null;
  position: string | null;
  hasPin: boolean;
}

export interface DeviceRequest extends Request {
  device: Device;
}

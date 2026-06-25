import { Request } from 'express';
import { Business } from '../database/schema';

/**
 * Business interface without password field
 */
export interface IBusiness extends Omit<Business, 'password'> {}

/**
 * Identity of the authenticated account behind the token. The owning business
 * is always available via `user`; this carries who is acting (owner or staff).
 */
export interface IAccount {
  type: 'business' | 'staff';
  id: string; // business.id for owner, staff.id for staff
  roleId?: string;
}

export interface AuthenticatedRequest extends Request {
  user: IBusiness;
  account: IAccount;
}

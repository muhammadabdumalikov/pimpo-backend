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
  businessId: string; // owning business — the scope every permission is read in
  roleId?: string;
  /**
   * Action permissions of this account, filled in lazily by PermissionService
   * on the first check of a request and reused for the rest of it (a request
   * may hit the guard and then a service-level assert). Never read from the
   * token — see PermissionService for why.
   */
  permissions?: string[];
}

export interface AuthenticatedRequest extends Request {
  user: IBusiness;
  account: IAccount;
}

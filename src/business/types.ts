import { Request } from 'express';
import { Business } from '../database/schema';

/**
 * Business interface without password field
 */
export interface IBusiness extends Omit<Business, 'password'> {}

export interface AuthenticatedRequest extends Request {
  user: IBusiness;
}

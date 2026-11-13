import {sql, type SQL} from 'drizzle-orm';
import {cashShifts} from '../database/schema';

/**
 * Shifts rung on one branch's registers. A shift has no branch of its own —
 * its register does — and a legacy register with no branch sells from the
 * business default branch.
 */
export function shiftsOfBranch(businessId: string, branchId: string): SQL {
  return sql`${cashShifts.registerId} IN (
    SELECT r.id FROM cash_registers r
    WHERE r.business_id = ${businessId}
      AND (r.branch_id = ${branchId}
        OR (r.branch_id IS NULL AND EXISTS (
          SELECT 1 FROM branches b
          WHERE b.id = ${branchId} AND b.business_id = ${businessId} AND b.is_default)))
  )`;
}

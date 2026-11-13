import {SetMetadata} from '@nestjs/common';

export const BRANCH_SCOPE_KEY = 'branchScope';

/**
 * How a read route treats a staff account pinned to one branch (no
 * `branch:all`):
 *  - 'filter'   — its `branchId` query is forced to the account's branch, so
 *                 the route can only answer for that branch.
 *  - 'business' — the route answers for the whole business and cannot be
 *                 narrowed (debts, stock valuation, cross-branch comparisons),
 *                 so a pinned account is refused.
 * Method metadata overrides class metadata. Routes without it are untouched.
 */
export type BranchScopeMode = 'filter' | 'business';

export const BranchScope = (mode: BranchScopeMode) =>
  SetMetadata(BRANCH_SCOPE_KEY, mode);

// Errors the database raises on purpose, recognised so the API answers them
// with their own code instead of a 500.

/** The message the branch_stock trigger raises (migration 0121). */
export const BRANCH_CLOSED_DB_MESSAGE = 'BRANCH_CLOSED';

/**
 * True for the branch_stock trigger's refusal: a stock change in a store whose
 * seat went unpaid (FILIAL-OBUNA.md Q3). Drizzle wraps the driver's error, so
 * the cause chain is walked too.
 */
export function isBranchClosedError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth++) {
    const {code, message} = e as {code?: unknown; message?: unknown};
    if (code === 'P0001' && message === BRANCH_CLOSED_DB_MESSAGE) return true;
    e = (e as {cause?: unknown}).cause;
  }
  return false;
}

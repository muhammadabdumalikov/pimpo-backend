/**
 * Ready-made permission sets for roles the app creates by itself, so an owner
 * gets a working account for the common case without opening the roles screen.
 * Built only from PERMISSION_CATALOG keys (role-presets.spec.ts checks it). A
 * preset is copied into the role when the role is created; editing it here
 * never touches roles that already exist.
 */

/**
 * "Kassir": someone who works the till and nothing else — the role the setup
 * wizard's "Sotuvchingiz bormi?" step creates (AI-SOZLASH.md §2).
 *
 * Product and stock reads, the registers and the payment methods are open to
 * every account (see the catalogue header), so they need no key here. A sale on
 * debt is sale:create, and it finds or creates the customer by name + phone on
 * its own. Shift close is limited to the cashier's own shift by ShiftService.
 *
 * Left out on purpose, although part of each is till work, because the key
 * also carries something a cashier should not get; the owner adds it by hand:
 *  • cash:movement   — kirim/chiqim, but also paying a supplier from the till
 *  • debt:manage     — taking a debt payment, but also editing/deleting debts
 *  • customer:manage — adding a customer, but also editing/deleting them
 *  • sale:delete     — for staff only drops a parked cart (a real sale is
 *                      owner-only), but it is still a delete key
 * Kept although wider than "own": sale:read shows every sale of the cashier's
 * branch, not only their own — the catalogue has no per-person scope — and it
 * is what the held-carts list, the sales list and receipt reprint need.
 */
export const CASHIER_PERMISSIONS: readonly string[] = [
  'sale:create',
  'sale:read',
  'shift:open',
  'shift:close',
  'customer:read',
  'debt:read',
];

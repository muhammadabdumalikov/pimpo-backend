import {SetMetadata} from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Marks a route (or a whole controller) as requiring the listed ACTION
 * permissions. Enforced by PermissionsGuard, which must run after JwtAuthGuard
 * so the acting account is known. The business owner always passes.
 *
 * Usage:
 *   @RequirePermission('receipt:receive')
 *   @Post(':id/receive') ...
 *
 * When the required permission depends on the request BODY (guards run before
 * validation pipes, so the body is unvalidated there), don't reach into it from
 * a guard — call PermissionService.assert() in the controller/service instead.
 */
export const RequirePermission = (...perms: string[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);

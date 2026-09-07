import {Global, Module} from '@nestjs/common';
import {PermissionService} from './permission.service';
import {PermissionsGuard} from './permissions.guard';

/**
 * Global so any controller can `@UseGuards(PermissionsGuard)` and any service
 * can inject PermissionService without wiring an import per feature module.
 * Depends only on the global DatabaseModule + CacheModule, so it introduces no
 * module cycles.
 */
@Global()
@Module({
  providers: [PermissionService, PermissionsGuard],
  exports: [PermissionService, PermissionsGuard],
})
export class PermissionModule {}

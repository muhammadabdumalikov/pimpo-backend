import {Global, Module} from '@nestjs/common';
import {APP_INTERCEPTOR} from '@nestjs/core';
import {PermissionService} from './permission.service';
import {PermissionsGuard} from './permissions.guard';
import {BranchScopeService} from './branch-scope.service';
import {BranchScopeInterceptor} from './branch-scope.interceptor';

/**
 * Global so any controller can `@UseGuards(PermissionsGuard)` and any service
 * can inject PermissionService without wiring an import per feature module.
 * Depends only on the global DatabaseModule + CacheModule, so it introduces no
 * module cycles.
 */
@Global()
@Module({
  providers: [
    PermissionService,
    PermissionsGuard,
    BranchScopeService,
    // Global: a no-op on routes without @BranchScope().
    {provide: APP_INTERCEPTOR, useClass: BranchScopeInterceptor},
  ],
  exports: [PermissionService, PermissionsGuard, BranchScopeService],
})
export class PermissionModule {}

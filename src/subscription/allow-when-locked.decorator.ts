import {SetMetadata} from '@nestjs/common';

export const ALLOW_WHEN_LOCKED_KEY = 'allowWhenLocked';

/**
 * Keeps a signed-in route open while the shop is locked for non-payment (see
 * SubscriptionLockInterceptor). Only what the lock screen itself needs belongs
 * here: who is signed in, the billing routes that let the owner pay, and the
 * app-shell reads that would otherwise fail on every page load.
 * Method metadata overrides class metadata.
 */
export const AllowWhenLocked = () => SetMetadata(ALLOW_WHEN_LOCKED_KEY, true);

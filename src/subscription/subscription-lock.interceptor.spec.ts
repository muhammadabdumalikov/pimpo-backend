import {Reflector} from '@nestjs/core';
import {ExecutionContext} from '@nestjs/common';
import {of} from 'rxjs';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {AllowWhenLocked} from './allow-when-locked.decorator';
import {SubscriptionLockInterceptor} from './subscription-lock.interceptor';
import {SubscriptionService} from './subscription.service';
import {BranchScopeService} from '../permission/branch-scope.service';

class Shop {
  sell() {}
  @AllowWhenLocked()
  me() {}
}

@AllowWhenLocked()
class Billing {
  pay() {}
}

const ctx = (
  cls: new () => object,
  handler: string,
  user: {id: string} | undefined,
): ExecutionContext =>
  ({
    getType: () => 'http',
    getClass: () => cls,
    getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
    switchToHttp: () => ({getRequest: () => ({user})}),
  }) as unknown as ExecutionContext;

describe('SubscriptionLockInterceptor', () => {
  const next = {handle: jest.fn(() => of('ok'))};
  const run = (locked: boolean, c: ExecutionContext) => {
    const isLocked = jest.fn(async () => locked);
    const interceptor = new SubscriptionLockInterceptor(new Reflector(), {
      isLocked,
    } as unknown as SubscriptionService);
    return {result: interceptor.intercept(c, next), isLocked};
  };

  beforeEach(() => next.handle.mockClear());

  it('refuses every signed-in route of a locked shop with SUBSCRIPTION_LOCKED', async () => {
    const {result} = run(true, ctx(Shop, 'sell', {id: 'b1'}));
    await expect(result).rejects.toMatchObject({
      code: ErrorCode.SUBSCRIPTION_LOCKED,
    });
    await expect(run(true, ctx(Shop, 'sell', {id: 'b1'})).result).rejects.toBeInstanceOf(
      AppException,
    );
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('lets a shop that is not locked through', async () => {
    await run(false, ctx(Shop, 'sell', {id: 'b1'})).result;
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('keeps routes marked on the method or the class open, without a lookup', async () => {
    const a = run(true, ctx(Shop, 'me', {id: 'b1'}));
    await a.result;
    const b = run(true, ctx(Billing, 'pay', {id: 'b1'}));
    await b.result;
    expect(next.handle).toHaveBeenCalledTimes(2);
    expect(a.isLocked).not.toHaveBeenCalled();
    expect(b.isLocked).not.toHaveBeenCalled();
  });

  it('ignores requests with no signed-in shop (public, platform)', async () => {
    const {result, isLocked} = run(true, ctx(Shop, 'sell', undefined));
    await result;
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(isLocked).not.toHaveBeenCalled();
  });

  describe('a staff account pinned to a closed store (FILIAL-OBUNA.md Q3)', () => {
    const staffCtx = (account: {type: string; id: string}) =>
      ({
        getType: () => 'http',
        getClass: () => Shop,
        getHandler: () => (Shop.prototype as unknown as Record<string, unknown>).sell,
        switchToHttp: () => ({getRequest: () => ({user: {id: 'b1'}, account})}),
      }) as unknown as ExecutionContext;
    const runStaff = (closed: string[], pinned: string | null, account = {type: 'staff', id: 's1'}) => {
      const scopeFor = jest.fn(async () => pinned);
      const interceptor = new SubscriptionLockInterceptor(
        new Reflector(),
        {isLocked: async () => false, closedBranchIds: async () => closed} as unknown as SubscriptionService,
        {scopeFor} as unknown as BranchScopeService,
      );
      return {result: interceptor.intercept(staffCtx(account), next), scopeFor};
    };

    it('is refused with BRANCH_LOCKED', async () => {
      await expect(runStaff(['br2'], 'br2').result).rejects.toMatchObject({
        code: ErrorCode.BRANCH_LOCKED,
      });
    });

    it('passes when its own store is open, or it sees every store', async () => {
      await runStaff(['br2'], 'br1').result;
      await runStaff(['br2'], null).result;
      expect(next.handle).toHaveBeenCalledTimes(2);
    });

    it('skips the scope lookup when no store is closed, and for the owner', async () => {
      const a = runStaff([], 'br2');
      await a.result;
      const b = runStaff(['br2'], 'br2', {type: 'business', id: 'b1'});
      await b.result;
      expect(a.scopeFor).not.toHaveBeenCalled();
      expect(b.scopeFor).not.toHaveBeenCalled();
    });
  });
});

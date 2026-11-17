import type {ModuleRef} from '@nestjs/core';
import type {DatabaseService} from '../database/database.service';
import type {Business} from '../database/schema';
import {PlatformService} from '../platform/platform.service';
import {BusinessService} from './business.service';
import {signupAlertText} from './signup-alert';

/** A drizzle stand-in: every chain call returns itself; each await yields the next queued result. */
function fakeDb(results: unknown[][]): DatabaseService {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          const r = results.shift() ?? [];
          return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve(r).then(ok, ko);
        }
        return () => chain;
      },
    },
  );
  return {db: chain} as unknown as DatabaseService;
}

const row: Business = {
  id: 'b-1',
  name: 'Bek Market',
  email: null,
  phone: '+998901234567',
  login: 'bekmarket',
  password: 'hash',
  businessType: 'retail',
  isActive: true,
  createdAt: new Date('2026-11-17T09:05:00.000Z'),
} as unknown as Business;

// create(): login clash check → [], insert … returning → [row], trial plan → [] (skipped).
const createResults = () => [[], [row], []];

const flush = () => new Promise((r) => setImmediate(r));

function setup(sendMessage: jest.Mock, configured = true) {
  const sender = {isConfigured: jest.fn(() => configured), sendMessage};
  const moduleRef = {get: jest.fn(() => sender)} as unknown as ModuleRef;
  const service = new BusinessService(fakeDb(createResults()), moduleRef);
  return {service, sender, moduleRef};
}

const input = {
  name: 'Bek Market',
  phone: '90 123 45 67',
  login: 'bekmarket',
  password: 'secret1',
};

describe('sign-up Telegram alert', () => {
  const saved = process.env.PLATFORM_ALERT_CHAT_ID;
  beforeEach(() => {
    process.env.PLATFORM_ALERT_CHAT_ID = ' -100123 ';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.PLATFORM_ALERT_CHAT_ID;
    else process.env.PLATFORM_ALERT_CHAT_ID = saved;
  });

  it('public sign-up sends exactly one message to the alert chat', async () => {
    const send = jest.fn().mockResolvedValue({message_id: 1});
    const {service} = setup(send);
    const business = await service.register(input);
    await flush();
    expect(business.id).toBe('b-1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      '-100123',
      "🆕 Yangi do'kon ro'yxatdan o'tdi\n" +
        "Do'kon: Bek Market\n" +
        'Telefon: +998901234567\n' +
        'Login: bekmarket\n' +
        "Turi: Do'kon\n" +
        'Vaqt: 2026-11-17 14:05 (Toshkent)',
    );
  });

  it('create() — the platform console path — sends nothing', async () => {
    const send = jest.fn().mockResolvedValue({message_id: 1});
    const {service, moduleRef} = setup(send);
    await service.create(input);
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(moduleRef.get).not.toHaveBeenCalled();
  });

  it('the platform console creates through create(), not register()', async () => {
    const businessService = {
      create: jest.fn().mockResolvedValue(row),
      register: jest.fn(),
    } as unknown as BusinessService;
    const platform = new PlatformService(
      fakeDb([]),
      businessService,
      {} as never,
      {} as never,
      {} as never,
    );
    const created = await platform.createBusiness(input);
    expect(businessService.create).toHaveBeenCalledTimes(1);
    expect(businessService.register).not.toHaveBeenCalled();
    expect(created).not.toHaveProperty('password');
  });

  it('a failing sender does not fail the sign-up', async () => {
    const send = jest.fn().mockRejectedValue(new Error('Telegram down'));
    const {service} = setup(send);
    await expect(service.register(input)).resolves.toMatchObject({id: 'b-1'});
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a sender that cannot even be resolved does not fail the sign-up', async () => {
    const moduleRef = {
      get: jest.fn(() => {
        throw new Error('no provider');
      }),
    } as unknown as ModuleRef;
    const service = new BusinessService(fakeDb(createResults()), moduleRef);
    await expect(service.register(input)).resolves.toMatchObject({id: 'b-1'});
    await flush();
  });

  it('the sign-up does not wait for Telegram', async () => {
    const send = jest.fn(() => new Promise(() => undefined)); // never settles
    const {service} = setup(send);
    await expect(service.register(input)).resolves.toMatchObject({id: 'b-1'});
  });

  it('is a no-op without the chat id or the bot token', async () => {
    const send = jest.fn().mockResolvedValue({message_id: 1});
    delete process.env.PLATFORM_ALERT_CHAT_ID;
    await setup(send).service.register(input);
    process.env.PLATFORM_ALERT_CHAT_ID = '-100123';
    await setup(send, false).service.register(input);
    await flush();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('signupAlertText', () => {
  it('says plainly when there is no phone and names the type', () => {
    const text = signupAlertText({
      name: 'Osh markazi',
      phone: null,
      login: 'osh',
      businessType: 'food',
      createdAt: new Date('2026-12-31T20:30:00.000Z'),
    });
    expect(text).toContain("Telefon: yo'q");
    expect(text).toContain('Turi: Oshxona (fast-food)');
    // 20:30 UTC is already the next day in Tashkent.
    expect(text).toContain('Vaqt: 2027-01-01 01:30 (Toshkent)');
  });

  it('labels an online seller', () => {
    expect(
      signupAlertText({name: 'x', phone: '+998', login: 'x', businessType: 'online', createdAt: null}),
    ).toContain('Turi: Onlayn sotuvchi');
  });
});

import {businesses, roles, staff} from '../database/schema';
import {StaffService} from './staff.service';

/**
 * A drizzle stand-in that answers by table: `select().from(t)…` resolves to
 * the rows given for t (or [] for any other table); insert/returning echoes.
 */
function fakeDb(rows: Map<unknown, unknown[]>) {
  const chain = (result: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
          }
          return () => chain(result);
        },
      },
    );
  return {
    select: () => ({from: (table: unknown) => chain(rows.get(table) ?? [])}),
    insert: jest.fn(() => chain([{id: 'new-staff'}])),
  };
}

function setup(rows: Array<[unknown, unknown[]]>) {
  const db = fakeDb(new Map(rows));
  const service = new StaffService(
    {db} as never,
    {getSubscriptionLimits: async () => ({usersLimit: null})} as never,
    {invalidate: async () => undefined} as never,
  );
  return {service, db};
}

const account = {name: 'Dilnoza', hasAccount: true, login: 'dilnoza', password: 'secret1', roleId: 'r-1'};
const code = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: {code?: string}) => e.code,
  );

describe('staff login vs owner logins', () => {
  it("refuses a login equal to a shop owner's (sign-in would find the owner first)", async () => {
    const {service, db} = setup([
      [roles, [{id: 'r-1'}]],
      [businesses, [{id: 'b-any'}]],
    ]);
    expect(await code(service.create('b-1', account))).toBe('STAFF_LOGIN_EXISTS');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('still refuses a login another employee holds', async () => {
    const {service} = setup([
      [roles, [{id: 'r-1'}]],
      [staff, [{id: 's-other'}]],
    ]);
    expect(await code(service.create('b-1', account))).toBe('STAFF_LOGIN_EXISTS');
  });

  it("keeps the employee's own row out of the clash on update", async () => {
    const {service} = setup([[staff, [{id: 's-1'}]]]);
    const check = (service as unknown as {
      assertLoginFree(login: string, excludeId?: string): Promise<void>;
    }).assertLoginFree.bind(service);
    await expect(check('dilnoza', 's-1')).resolves.toBeUndefined();
    expect(await code(check('dilnoza', 's-2'))).toBe('STAFF_LOGIN_EXISTS');
  });

  it('a free login passes', async () => {
    const {service, db} = setup([[roles, [{id: 'r-1'}]]]);
    expect(await code(service.create('b-1', account))).toBeUndefined();
    expect(db.insert).toHaveBeenCalled();
  });
});

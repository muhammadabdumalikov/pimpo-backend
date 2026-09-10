import {ScaleService} from './scale.service';

/**
 * A stand-in for the two reads assignMissingPlus makes, plus a record of the
 * UPDATE it issues. `select({plu})` asks for taken numbers, `select({id})` for
 * the candidates — the shape of the projection is how we tell them apart.
 */
function makeService(taken: (number | null)[], candidates: string[]) {
  const executed: unknown[] = [];
  const db = {
    select: (projection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const rows =
            'plu' in projection
              ? taken.map((plu) => ({plu}))
              : candidates.map((id) => ({id}));
          // The candidate query adds .orderBy(); the taken one does not.
          return Object.assign(Promise.resolve(rows), {
            orderBy: () => Promise.resolve(rows),
          });
        },
      }),
    }),
    execute: (statement: unknown) => {
      executed.push(statement);
      return Promise.resolve([]);
    },
  };
  const service = new ScaleService({db} as never, {} as never);
  return {service, executed};
}

/**
 * The bound values inside a drizzle SQL object, in order. Its queryChunks mix
 * static fragments ({value: [...]}) with the bound values themselves, which sit
 * there as plain primitives.
 */
function paramsOf(statement: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') {
      out.push(node);
      return;
    }
    const chunks = (node as {queryChunks?: unknown[]}).queryChunks;
    if (chunks) chunks.forEach(walk);
  };
  walk(statement);
  return out;
}

function withRange(service: ScaleService, min: number, max: number) {
  jest.spyOn(service, 'pluRange').mockResolvedValue({min, max});
}

describe('assignMissingPlus', () => {
  it('fills the gaps below and around a number already in use', async () => {
    const {service} = makeService([5], ['a', 'b', 'c', 'd', 'e']);
    withRange(service, 1, 100);
    // 5 is taken, so the run must step over it: 1,2,3,4 then 6.
    await expect(service.assignMissingPlus('b1')).resolves.toEqual({
      assigned: 5,
      remaining: 0,
    });
  });

  it('starts at the configured floor, not at 1', async () => {
    const {service, executed} = makeService([], ['a']);
    withRange(service, 500, 999);
    await service.assignMissingPlus('b1');
    expect(paramsOf(executed[0])).toContain(500);
  });

  it('numbers what it can and reports the rest when the window runs out', async () => {
    const {service} = makeService([], ['a', 'b', 'c', 'd', 'e']);
    withRange(service, 1, 3);
    // Failing the whole batch would leave the shop guessing how far it got.
    await expect(service.assignMissingPlus('b1')).resolves.toEqual({
      assigned: 3,
      remaining: 2,
    });
  });

  it('treats numbers outside the window as no obstacle', async () => {
    // 4000 was assigned before the window was narrowed to 1..10.
    const {service} = makeService([4000], ['a']);
    withRange(service, 1, 10);
    await expect(service.assignMissingPlus('b1')).resolves.toEqual({
      assigned: 1,
      remaining: 0,
    });
  });

  it('issues no statement when there is nothing to number', async () => {
    const {service, executed} = makeService([1, 2], []);
    withRange(service, 1, 100);
    await expect(service.assignMissingPlus('b1')).resolves.toEqual({
      assigned: 0,
      remaining: 0,
    });
    expect(executed).toHaveLength(0);
  });
});

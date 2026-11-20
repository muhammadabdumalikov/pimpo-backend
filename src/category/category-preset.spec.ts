import {planPreset} from './category.service';

const names = (uz: string, uzc: string, ru: string, en: string) => ({
  nameUz: uz,
  nameUzc: uzc,
  nameRu: ru,
  nameEn: en,
});
const snap = {
  categories: new Map(
    [
      {key: 'dairy', ...names('Sut mahsulotlari', 'Сут маҳсулотлари', 'Молочные продукты', 'Dairy')},
      {key: 'drinks', ...names('Ichimliklar', 'Ичимликлар', 'Напитки', 'Drinks')},
      {key: 'bread', ...names('Non', 'Нон', 'Хлеб', 'Bread')},
    ].map((c) => [c.key, {...c, image: null, isHidden: false, sort: 0} as never]),
  ),
};
const row = (id: string, name: string | null, globalKey: string | null, isDeleted = false) => ({
  id,
  name,
  globalKey,
  isDeleted,
});

describe('planPreset', () => {
  it('adds new global rows and own names to an empty shop', () => {
    expect(planPreset([], snap, ['dairy', 'drinks'], ['Tormoz qismlari'])).toEqual({
      revive: [],
      insertGlobal: ['dairy', 'drinks'],
      insertCustom: ['Tormoz qismlari'],
      skipped: 0,
    });
  });

  it('skips a global key already live, revives a removed one', () => {
    const rows = [row('g-dairy', null, 'dairy'), row('g-drinks', null, 'drinks', true)];
    expect(planPreset(rows, snap, ['dairy', 'drinks'], [])).toEqual({
      revive: ['g-drinks'],
      insertGlobal: [],
      insertCustom: [],
      skipped: 1,
    });
  });

  it('skips a global category the shop already has under its own name, any language', () => {
    const rows = [row('c1', 'напитки', null)];
    const plan = planPreset(rows, snap, ['drinks', 'bread'], []);
    expect(plan.insertGlobal).toEqual(['bread']);
    expect(plan.skipped).toBe(1);
  });

  it('skips an own name that a live category already answers to', () => {
    const rows = [row('g-bread', null, 'bread')];
    const plan = planPreset(rows, snap, ['dairy'], ['Хлеб', 'dairy', 'Kolbasa']);
    expect(plan.insertCustom).toEqual(['Kolbasa']);
    expect(plan.skipped).toBe(2);
  });

  it('revives a removed own category of the same name instead of a duplicate', () => {
    const rows = [row('c9', 'Kolbasa ', null, true)];
    const plan = planPreset(rows, snap, [], ['kolbasa']);
    expect(plan).toEqual({revive: ['c9'], insertGlobal: [], insertCustom: [], skipped: 0});
  });

  it('ignores a key the snapshot does not know', () => {
    expect(planPreset([], snap, ['ghost'], []).insertGlobal).toEqual([]);
  });
});

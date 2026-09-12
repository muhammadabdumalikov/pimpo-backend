import {parseFields, pickRowFields, selectFields} from './field-selection';

describe('parseFields', () => {
  it('is undefined when nothing was asked for', () => {
    expect(parseFields(undefined)).toBeUndefined();
    expect(parseFields('')).toBeUndefined();
    expect(parseFields(' , ,')).toBeUndefined();
    expect(parseFields(42)).toBeUndefined();
  });

  it('splits and trims a comma list', () => {
    expect([...parseFields('name, priceOut ,quantity')!]).toEqual([
      'name',
      'priceOut',
      'quantity',
    ]);
  });

  it('accepts a repeated query param', () => {
    expect([...parseFields(['name,code', 'barcode'])!]).toEqual([
      'name',
      'code',
      'barcode',
    ]);
  });
});

describe('selectFields', () => {
  const selection = {id: 'c_id', name: 'c_name', code: 'c_code', price: 'c_p'};

  it('returns the full selection when no fields are requested', () => {
    expect(selectFields(selection, undefined)).toBe(selection);
  });

  it('keeps requested keys plus id, ignoring unknown names', () => {
    expect(selectFields(selection, new Set(['name', 'nope']))).toEqual({
      id: 'c_id',
      name: 'c_name',
    });
  });

  it('honours a custom always list', () => {
    expect(
      selectFields(selection, new Set(['price']), ['id', 'code']),
    ).toEqual({id: 'c_id', code: 'c_code', price: 'c_p'});
  });
});

describe('pickRowFields', () => {
  const rows = [
    {id: '1', name: 'A', total: 10},
    {id: '2', name: 'B', total: 20},
  ];

  it('returns rows untouched when no fields are requested', () => {
    expect(pickRowFields(rows, undefined)).toBe(rows);
  });

  it('drops keys that were not requested', () => {
    expect(pickRowFields(rows, new Set(['total']))).toEqual([
      {id: '1', total: 10},
      {id: '2', total: 20},
    ]);
  });
});

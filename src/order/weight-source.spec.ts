import {weightSourceFor} from './weight-source';
import {SYSTEM_KG_UNIT_ID} from '../unit/unit.service';

describe('weightSourceFor', () => {
  const kg = {unitId: SYSTEM_KG_UNIT_ID, quantityType: 'kg'};

  it('keeps the till claim on a kilogram line', () => {
    expect(weightSourceFor(kg, 'scale')).toBe('scale');
    expect(weightSourceFor(kg, 'label')).toBe('label');
    expect(weightSourceFor(kg, 'manual')).toBe('manual');
  });

  it('stores null when the till sent nothing', () => {
    expect(weightSourceFor(kg, undefined)).toBeNull();
    expect(weightSourceFor(kg, null)).toBeNull();
  });

  // Litres and metres are fractional too (quantityType 'kg'), but a scale
  // never weighed them — a claim there would only pollute the audit filter.
  it('drops the claim on other fractional units', () => {
    expect(
      weightSourceFor({unitId: 'unit-litr', quantityType: 'kg'}, 'manual'),
    ).toBeNull();
  });

  it('drops the claim on piece products', () => {
    expect(
      weightSourceFor(
        {unitId: 'unit-system-dona', quantityType: 'piece'},
        'scale',
      ),
    ).toBeNull();
  });

  it('treats a pre-units kg product as weighed', () => {
    expect(weightSourceFor({unitId: null, quantityType: 'kg'}, 'scale')).toBe(
      'scale',
    );
    expect(
      weightSourceFor({unitId: null, quantityType: 'piece'}, 'scale'),
    ).toBeNull();
  });
});

import {asRollout, isFeatureOn} from './feature.resolve';

describe('isFeatureOn', () => {
  it('off is a kill switch — even an enabled override stays off', () => {
    expect(isFeatureOn('off', undefined)).toBe(false);
    expect(isFeatureOn('off', true)).toBe(false);
    expect(isFeatureOn('off', false)).toBe(false);
  });

  it('selected is on only for an explicit enable', () => {
    expect(isFeatureOn('selected', true)).toBe(true);
    expect(isFeatureOn('selected', undefined)).toBe(false);
    expect(isFeatureOn('selected', false)).toBe(false);
  });

  it('all is on for everyone except an explicit disable', () => {
    expect(isFeatureOn('all', undefined)).toBe(true);
    expect(isFeatureOn('all', true)).toBe(true);
    expect(isFeatureOn('all', false)).toBe(false);
  });
});

describe('asRollout', () => {
  it('keeps known values and reads anything else as off', () => {
    expect(asRollout('all')).toBe('all');
    expect(asRollout('selected')).toBe('selected');
    expect(asRollout('beta')).toBe('off');
    expect(asRollout(null)).toBe('off');
    expect(asRollout(undefined)).toBe('off');
  });
});

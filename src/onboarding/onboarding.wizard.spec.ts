import {buildWizardState, wizardAppliesTo} from './onboarding.wizard';

const row = (over: Partial<Parameters<typeof buildWizardState>[0]> = {}) => ({
  businessType: 'retail',
  setupStatus: null,
  setupStep: null,
  directions: null,
  directionText: null,
  ...over,
});

describe('setup wizard state', () => {
  it('applies to shops and online sellers, not kitchens', () => {
    expect(wizardAppliesTo('retail')).toBe(true);
    expect(wizardAppliesTo('online')).toBe(true);
    expect(wizardAppliesTo('food')).toBe(false);
  });

  it('opens by itself only for an untouched, empty shop', () => {
    expect(buildWizardState(row(), true).eligible).toBe(true);
    expect(buildWizardState(row({businessType: 'online'}), true).eligible).toBe(true);
    expect(buildWizardState(row(), false).eligible).toBe(false);
    expect(buildWizardState(row({businessType: 'food'}), true).eligible).toBe(false);
    expect(buildWizardState(row({setupStatus: 'skipped'}), true).eligible).toBe(false);
    expect(buildWizardState(row({setupStatus: 'done'}), true).eligible).toBe(false);
  });

  it('reads unknown stored values as unset', () => {
    const s = buildWizardState(row({setupStatus: 'weird', setupStep: 'nope'}), true);
    expect(s.status).toBeNull();
    expect(s.step).toBeNull();
    expect(s.eligible).toBe(true);
  });

  it('passes the saved answers through', () => {
    const s = buildWizardState(
      row({setupStep: 'categories', directions: ['grocery'], directionText: 'avto moy'}),
      true,
    );
    expect(s).toEqual({
      eligible: true,
      status: null,
      step: 'categories',
      directions: ['grocery'],
      directionText: 'avto moy',
    });
  });
});

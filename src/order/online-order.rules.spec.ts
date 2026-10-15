import {
  canTransition,
  deliveryFeeFor,
  deliveryTypeOf,
  legacyTarget,
} from './online-order.rules';

describe('online order transitions', () => {
  it('walks the delivery flow forward', () => {
    expect(canTransition('Pending', 'Assembling', 'delivery')).toBe(true);
    expect(canTransition('Assembling', 'Delivering', 'delivery')).toBe(true);
    expect(canTransition('Delivering', 'Completed', 'delivery')).toBe(true);
  });

  it('walks the pickup flow forward', () => {
    expect(canTransition('Assembling', 'ReadyForPickup', 'pickup')).toBe(true);
    expect(canTransition('ReadyForPickup', 'Completed', 'pickup')).toBe(true);
  });

  it('keeps each flow to its own middle step', () => {
    expect(canTransition('Assembling', 'ReadyForPickup', 'delivery')).toBe(
      false,
    );
    expect(canTransition('Assembling', 'Delivering', 'pickup')).toBe(false);
  });

  it('allows skipping ahead (Q7)', () => {
    expect(canTransition('Pending', 'Completed', 'pickup')).toBe(true);
    expect(canTransition('Pending', 'Delivering', 'delivery')).toBe(true);
  });

  it('never goes back or out of a final state', () => {
    expect(canTransition('Delivering', 'Assembling', 'delivery')).toBe(false);
    expect(canTransition('Assembling', 'Pending', 'delivery')).toBe(false);
    expect(canTransition('Assembling', 'Assembling', 'delivery')).toBe(false);
    expect(canTransition('Completed', 'Cancelled', 'pickup')).toBe(false);
    expect(canTransition('Cancelled', 'Pending', 'pickup')).toBe(false);
    expect(canTransition('Held', 'Completed', 'pickup')).toBe(false);
  });

  it('cancels from any open step (Q8)', () => {
    for (const s of ['Pending', 'Assembling', 'Delivering', 'ReadyForPickup']) {
      expect(canTransition(s, 'Cancelled', 'delivery')).toBe(true);
    }
  });
});

describe('helpers', () => {
  it('reads a missing delivery type as pickup', () => {
    expect(deliveryTypeOf(null)).toBe('pickup');
    expect(deliveryTypeOf('delivery')).toBe('delivery');
  });

  it('maps the old status values', () => {
    expect(legacyTarget('Confirmed')).toBe('Assembling');
    expect(legacyTarget('Completed')).toBe('Completed');
    expect(legacyTarget('Pending')).toBeNull();
  });

  it('frees delivery from the threshold up', () => {
    const s = {deliveryFee: 15000, freeDeliveryFrom: 200000};
    expect(deliveryFeeFor(199999, s)).toBe(15000);
    expect(deliveryFeeFor(200000, s)).toBe(0);
    expect(
      deliveryFeeFor(50000, {deliveryFee: 15000, freeDeliveryFrom: null}),
    ).toBe(15000);
  });
});

import {PIN_PATTERN, hashPin, verifyPin} from './pin';

describe('till PIN hashing', () => {
  it('verifies the PIN it hashed and nothing else', async () => {
    const stored = await hashPin('4821');
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true);
    await expect(verifyPin('4821', stored)).resolves.toBe(true);
    await expect(verifyPin('4822', stored)).resolves.toBe(false);
    await expect(verifyPin('48210', stored)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPin('0000')).not.toBe(await hashPin('0000'));
  });

  it('rejects a hash it does not recognise instead of throwing', async () => {
    await expect(verifyPin('4821', 'salt:sha256hex')).resolves.toBe(false);
    await expect(verifyPin('4821', '')).resolves.toBe(false);
  });

  it('accepts 4–6 digits only', () => {
    for (const ok of ['0000', '12345', '999999']) {
      expect(PIN_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ['123', '1234567', '12a4', ' 1234', '']) {
      expect(PIN_PATTERN.test(bad)).toBe(false);
    }
  });
});

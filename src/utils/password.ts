import { createHash, randomBytes } from 'crypto';

/**
 * Hash a string using SHA-256
 * Returns a string in format: salt:hash (salt is hex, hash is hex)
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(salt + password).digest('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a hash
 * @param password - Plain text password to verify
 * @param hash - Hash string in format salt:hash
 */
export function verifyPassword(password: string, hash: string): boolean {
  const [salt, storedHash] = hash.split(':');
  
  if (!salt || !storedHash) {
    return false;
  }

  const computedHash = createHash('sha256').update(salt + password).digest('hex');
  return computedHash === storedHash;
}

import { uuidv7 } from 'uuidv7';

/**
 * Generate a UUID v7 (time-ordered UUID)
 * UUID v7 is better for database performance as it's time-ordered
 * and maintains lexicographic sortability
 */
export function generateId(): string {
  return uuidv7();
}

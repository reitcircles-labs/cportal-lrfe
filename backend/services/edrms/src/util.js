import {timingSafeEqual} from 'node:crypto';

/**
 * Compares two values as strings in constant time for equal lengths (for secrets and
 * signatures).
 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

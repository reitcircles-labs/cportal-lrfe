import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

/** scrypt password hash, self-describing: scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
    return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
    if (!stored) return false;
    const [algo, n, r, p, salt, hash] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: +n, r: +r, p: +p });
    return timingSafeEqual(actual, expected);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
}

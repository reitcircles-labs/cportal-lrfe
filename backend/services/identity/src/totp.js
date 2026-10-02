import { createHmac, randomBytes } from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what Google/Microsoft Authenticator expect. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

export function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(str) {
    const clean = str.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = ALPHABET.indexOf(ch);
        if (idx < 0) throw new Error('Invalid base32 character');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20));

export function hotp(secret, counter, digits = DIGITS) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
    const o = h[h.length - 1] & 0xf;
    const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(code % 10 ** digits).padStart(digits, '0');
}

export const totp = (secret, at = Date.now(), digits = DIGITS) => hotp(secret, Math.floor(at / 1000 / STEP), digits);

/** Accept the current code and ±`window` steps of clock drift. */
export function verifyTotp(secret, code, at = Date.now(), window = 1) {
    if (!/^\d{6}$/.test(String(code))) return false;
    const counter = Math.floor(at / 1000 / STEP);
    for (let d = -window; d <= window; d++) {
        if (hotp(secret, counter + d) === String(code)) return true;
    }
    return false;
}

export function otpauthUrl(secret, account, issuer) {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

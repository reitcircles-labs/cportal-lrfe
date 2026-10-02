import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed links for stores without presigned URLs (local, memory): the browser can
 * open a file without an Authorization header, and the link only works for `ttl` seconds.
 */
export function createLinkSigner(secret) {
    if (!secret) throw new Error('createLinkSigner: secret is required');
    const sign = (subject, exp) => createHmac('sha256', secret).update(`${subject}:${exp}`).digest('base64url');
    return {
        sign(subject, ttlSeconds, now = Date.now()) {
            const exp = Math.floor(now / 1000) + ttlSeconds;
            return { exp, sig: sign(subject, exp) };
        },
        verify(subject, exp, sig, now = Date.now()) {
            if (!Number.isInteger(Number(exp)) || Number(exp) < Math.floor(now / 1000)) return false;
            const a = Buffer.from(String(sig)), b = Buffer.from(sign(subject, Number(exp)));
            return a.length === b.length && timingSafeEqual(a, b);
        }
    };
}

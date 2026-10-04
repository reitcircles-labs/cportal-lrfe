import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * A keyring without OpenBao, for tests and the e2e stack: data keys are wrapped with a random
 * in-memory key, in the same shape as OpenBao's transit ("fake:v1:…" instead of "vault:v1:…").
 * Nothing survives a restart, so files it encrypted cannot be read by another process.
 */
export function createFakeKeyring({ keyName = 'fake-files' } = {}) {
    const kek = randomBytes(32);
    return {
        name: 'fake',
        keyName,
        async newDataKey() {
            const plaintext = randomBytes(32);
            const iv = randomBytes(12);
            const c = createCipheriv('aes-256-gcm', kek, iv);
            const wrapped = Buffer.concat([iv, c.update(plaintext), c.final(), c.getAuthTag()]);
            return { plaintext, wrapped: `fake:v1:${wrapped.toString('base64')}`, keyName };
        },
        async unwrap({ wrapped, keyName: name }) {
            if (name !== keyName) throw Object.assign(new Error(`Key ${name} is not available to this keyring`), { code: 'EKEY' });
            const m = /^fake:v1:(.+)$/.exec(String(wrapped));
            if (!m) throw Object.assign(new Error('Not a wrapped key of this keyring'), { code: 'EKEY' });
            const raw = Buffer.from(m[1], 'base64');
            try {
                const d = createDecipheriv('aes-256-gcm', kek, raw.subarray(0, 12));
                d.setAuthTag(raw.subarray(raw.length - 16));
                return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
            } catch {
                throw Object.assign(new Error('The wrapped key does not belong to this keyring'), { code: 'EKEY' });
            }
        }
    };
}

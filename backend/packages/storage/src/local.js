import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { hashingStream } from './hashing.js';

/**
 * Filesystem blob store for local development (EDRMS_STORAGE=local). Has no signed URLs of its
 * own — edrms serves content through its HMAC-signed /content route instead.
 */
export function createLocalStore({ root }) {
    const base = resolve(root);
    const pathOf = (key) => {
        const p = resolve(join(base, key));
        if (!p.startsWith(base + sep)) throw new Error(`Invalid storage key ${key}`);
        return p;
    };
    return {
        kind: 'local',
        async put({ key, body }) {
            const target = pathOf(key);
            await mkdir(dirname(target), { recursive: true });
            const { stream, result } = hashingStream(body);
            await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
            return result();
        },
        async getStream(key) { return createReadStream(pathOf(key)); },
        async delete(key) { await rm(pathOf(key), { force: true }); },
        async signedUrl() { return null; }
    };
}

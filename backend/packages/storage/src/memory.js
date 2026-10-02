import { Readable } from 'node:stream';
import { hashingStream } from './hashing.js';

/** In-memory blob store for tests. Same interface as ./s3.js and ./local.js. */
export function createMemoryStore() {
    const blobs = new Map();
    return {
        kind: 'memory',
        blobs,
        async put({ key, body, contentType }) {
            const { stream, result } = hashingStream(body);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const { sha256, size } = await result();
            blobs.set(key, { data: Buffer.concat(chunks), contentType });
            return { sha256, size };
        },
        async getStream(key) {
            const blob = blobs.get(key);
            if (!blob) throw Object.assign(new Error(`No object at ${key}`), { code: 'NoSuchKey' });
            return Readable.from([blob.data]);
        },
        async delete(key) { blobs.delete(key); },
        async signedUrl() { return null; }
    };
}

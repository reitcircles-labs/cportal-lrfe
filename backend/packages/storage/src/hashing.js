import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

/**
 * Wrap a Buffer or stream so its SHA-256 and byte size are computed while it flows to storage.
 * `result()` resolves once the stream has been fully consumed.
 */
export function hashingStream(body) {
    const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    if (!source || typeof source.pipe !== 'function') throw new Error('body must be a Buffer or a readable stream');
    const hash = createHash('sha256');
    let size = 0;
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const tap = new Transform({
        transform(chunk, _enc, cb) {
            hash.update(chunk);
            size += chunk.length;
            cb(null, chunk);
        },
        flush(cb) {
            resolve({ sha256: hash.digest('hex'), size });
            cb();
        }
    });
    source.on('error', (err) => { reject(err); tap.destroy(err); });
    tap.on('error', reject);
    source.pipe(tap);
    return { stream: tap, result: () => done };
}

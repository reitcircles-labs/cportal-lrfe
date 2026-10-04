import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';

/**
 * The encrypted file format (format 1): chunked AES-256-GCM, so files of any size are encrypted
 * and decrypted while they stream.
 *
 *   header  20 bytes   "LRFE" · format (1) · 3 reserved · chunk size (uint32 BE) · nonce prefix (8)
 *   chunks             AES-256-GCM ciphertext of each chunk, followed by its 16-byte tag
 *
 * Every chunk has `chunkSize` plain bytes except the last, which has 1 to `chunkSize` (0 only for an
 * empty file): a chunk is only cut when more data follows. Nonce = nonce prefix ‖ chunk number
 * (uint32 BE). Authenticated data = header ‖ chunk number ‖ last-chunk flag, so a changed header,
 * a changed byte, reordered chunks, a cut-off end or appended bytes all fail authentication.
 *
 * Decryption releases each chunk only after its tag is verified. A cut-off file is detected at the
 * end of the stream (the last chunk read was not marked as last): a reader must treat the stream
 * as failed if it ends with an error, even after earlier chunks arrived.
 *
 * The key is the file's data-encryption key (32 bytes, see README.md section 3). It is not stored
 * here; the caller erases it when the stream is done.
 */

export const FORMAT = 1;
export const ALG = 'AES-256-GCM-CHUNKED';
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
const MAGIC = Buffer.from('LRFE');
const HEADER_SIZE = 20;
const TAG_SIZE = 16;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

export class DecryptionError extends Error {
    constructor(message = 'The stored file failed authentication: it was changed, cut off, or the key is wrong') {
        super(message);
        this.name = 'DecryptionError';
        this.code = 'EDECRYPT';
    }
}

/** Ciphertext size for `size` plain bytes (for checks and tests). */
export function cipherSizeOf(size, chunkSize = DEFAULT_CHUNK_SIZE) {
    const chunks = Math.max(1, Math.ceil(size / chunkSize));
    return HEADER_SIZE + size + chunks * TAG_SIZE;
}

function header(chunkSize, noncePrefix) {
    const h = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(h, 0);
    h.writeUInt8(FORMAT, 4);
    h.writeUInt32BE(chunkSize, 8);
    noncePrefix.copy(h, 12);
    return h;
}

function chunkParams(head, index, last) {
    const nonce = Buffer.alloc(12);
    head.copy(nonce, 0, 12, 20);
    nonce.writeUInt32BE(index, 8);
    const aad = Buffer.alloc(HEADER_SIZE + 5);
    head.copy(aad, 0);
    aad.writeUInt32BE(index, HEADER_SIZE);
    aad.writeUInt8(last ? 1 : 0, HEADER_SIZE + 4);
    return { nonce, aad };
}

function checkKey(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('The data-encryption key must be 32 bytes');
}

/** A Transform: plain bytes in, format-1 ciphertext out. */
export function createEncryptStream(key, { chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
    checkKey(key);
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) throw new Error(`chunkSize must be 1 to ${MAX_CHUNK_SIZE}`);
    const head = header(chunkSize, randomBytes(8));
    let pending = Buffer.alloc(0), index = 0, started = false;

    const seal = (plain, last) => {
        if (index > 0xffffffff) throw new Error('File too large for this format');
        const { nonce, aad } = chunkParams(head, index++, last);
        const c = createCipheriv('aes-256-gcm', key, nonce);
        c.setAAD(aad);
        return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    };
    return new Transform({
        transform(chunk, _enc, cb) {
            try {
                if (!started) { this.push(head); started = true; }
                pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
                while (pending.length > chunkSize) {        // more data follows: not the last chunk
                    this.push(seal(pending.subarray(0, chunkSize), false));
                    pending = pending.subarray(chunkSize);
                }
                cb();
            } catch (err) { cb(err); }
        },
        flush(cb) {
            try {
                if (!started) this.push(head);
                this.push(seal(pending, true));
                pending = Buffer.alloc(0);
                cb();
            } catch (err) { cb(err); }
        }
    });
}

/** A Transform: format-1 ciphertext in, plain bytes out; fails with DecryptionError. */
export function createDecryptStream(key) {
    checkKey(key);
    let head = null, frame = 0, pending = Buffer.alloc(0), index = 0;

    const open = (data, last) => {
        if (data.length < TAG_SIZE) throw new DecryptionError();
        const { nonce, aad } = chunkParams(head, index++, last);
        try {
            const d = createDecipheriv('aes-256-gcm', key, nonce);
            d.setAAD(aad);
            d.setAuthTag(data.subarray(data.length - TAG_SIZE));
            return Buffer.concat([d.update(data.subarray(0, data.length - TAG_SIZE)), d.final()]);
        } catch { throw new DecryptionError(); }
    };
    return new Transform({
        transform(chunk, _enc, cb) {
            try {
                pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
                if (!head) {
                    if (pending.length < HEADER_SIZE) return cb();
                    head = Buffer.from(pending.subarray(0, HEADER_SIZE));
                    pending = pending.subarray(HEADER_SIZE);
                    const chunkSize = head.readUInt32BE(8);
                    if (!head.subarray(0, 4).equals(MAGIC)) throw new DecryptionError('Not an encrypted file (no LRFE header)');
                    if (head.readUInt8(4) !== FORMAT) throw new DecryptionError(`Unsupported encrypted file format ${head.readUInt8(4)}`);
                    if (chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) throw new DecryptionError();
                    frame = chunkSize + TAG_SIZE;
                }
                while (pending.length > frame) {             // more data follows: not the last chunk
                    this.push(open(pending.subarray(0, frame), false));
                    pending = pending.subarray(frame);
                }
                cb();
            } catch (err) { cb(err); }
        },
        flush(cb) {
            try {
                if (!head) {
                    const plain = pending.length >= MAGIC.length && !pending.subarray(0, MAGIC.length).equals(MAGIC);
                    throw new DecryptionError(plain ? 'Not an encrypted file (no LRFE header)' : undefined);
                }
                this.push(open(pending, true));
                cb();
            } catch (err) { cb(err); }
        }
    });
}

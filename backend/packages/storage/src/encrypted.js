import { hashingStream } from './hashing.js';
import { ALG, DEFAULT_CHUNK_SIZE, FORMAT, createDecryptStream, createEncryptStream } from './encryption.js';

/**
 * A store that encrypts what it writes and decrypts what it reads (README.md section 6), around
 * any store with the usual interface (S3, local, memory).
 *
 *   const store = createEncryptingStore(createLocalStore({ root }), keyring);
 *   const { sha256, size, encryption } = await store.put({ key, body, contentType });
 *   // keep `encryption` with the file's record (database); pass it back to read:
 *   const stream = await store.getStream(key, { encryption });
 *
 * `put` asks the keyring for a new data-encryption key (DEK) per file, streams the file through
 * SHA-256 (of the plain file, as before) and chunked AES-256-GCM (./encryption.js), and returns the
 * plain `{ sha256, size }` plus `encryption`: { alg, format, keyName, wrappedKey, chunkSize,
 * cipherSha256, cipherSize }. The plain DEK is erased when the stream ends.
 *
 * `getStream(key, { encryption })` unwraps the DEK through the keyring and decrypts while
 * streaming; without `encryption` (files stored before encryption) it returns the stored bytes.
 * `signedUrl` returns null: a direct link would hand out ciphertext, so files are streamed through
 * the service's signed route.
 *
 * keyring: { newDataKey() → { plaintext: Buffer(32), wrapped, keyName }, unwrap({ wrapped, keyName }) → Buffer(32) }
 */
export function createEncryptingStore(store, keyring, { chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
    if (!store || !keyring) throw new Error('createEncryptingStore: a store and a keyring are required');
    const erase = (key) => { if (Buffer.isBuffer(key)) key.fill(0); };

    return {
        kind: `encrypted-${store.kind}`,
        inner: store,
        encrypted: true,
        async put({ key, body, contentType }) {
            const dek = await keyring.newDataKey();
            let enc;
            try {
                const plain = hashingStream(body);
                enc = createEncryptStream(dek.plaintext, { chunkSize });
                plain.stream.on('error', (err) => enc.destroy(err));
                enc.on('close', () => erase(dek.plaintext));
                plain.stream.pipe(enc);
                // the stored object is ciphertext: never label it with the plain file's type
                const [{ sha256, size }, stored] = await Promise.all([plain.result(), store.put({ key, body: enc, contentType: 'application/octet-stream' })]);
                return {
                    sha256, size,
                    encryption: { alg: ALG, format: FORMAT, keyName: dek.keyName, wrappedKey: dek.wrapped, chunkSize, cipherSha256: stored.sha256, cipherSize: stored.size }
                };
            } finally {
                if (!enc) erase(dek.plaintext);
            }
        },
        async getStream(key, { encryption } = {}) {
            if (!encryption) return store.getStream(key);
            if (encryption.alg !== ALG || encryption.format !== FORMAT) throw new Error(`Unsupported encryption ${encryption.alg} format ${encryption.format}`);
            const dek = await keyring.unwrap({ wrapped: encryption.wrappedKey, keyName: encryption.keyName });
            let source;
            try {
                source = await store.getStream(key);
            } catch (err) { erase(dek); throw err; }
            const dec = createDecryptStream(dek);
            dec.on('close', () => erase(dek));
            source.on('error', (err) => dec.destroy(err));
            return source.pipe(dec);
        },
        async delete(key) { return store.delete(key); },
        async signedUrl() { return null; }
    };
}

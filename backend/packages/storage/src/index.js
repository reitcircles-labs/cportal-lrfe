export { hashingStream } from './hashing.js';
export { createMemoryStore } from './memory.js';
export { createLocalStore } from './local.js';
export { createS3Store } from './s3.js';
export { createLinkSigner } from './links.js';
export { createEncryptingStore } from './encrypted.js';
export { createEncryptStream, createDecryptStream, cipherSizeOf, DecryptionError, ALG, FORMAT, DEFAULT_CHUNK_SIZE } from './encryption.js';
export { createFakeKeyring } from './fake-keyring.js';

/** <prefix>/<id>/v<version>/<safe file name> */
export function storageKey(prefix, id, versionNumber, fileName) {
    const safe = String(fileName || 'file').split(/[\\/]/).pop().trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    return `${prefix}/${id}/v${versionNumber}/${safe}`;
}

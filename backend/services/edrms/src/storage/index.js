import { env, envOneOf } from '@lrfe/common';
import { createMemoryStore, createLocalStore, createS3Store, createEncryptingStore, keyringFromEnv, storageKey as key } from '@lrfe/storage';

export { createMemoryStore, createLocalStore, createS3Store };

/** edrms/<documentId>/v<version>/<safe file name> */
export const storageKey = (documentId, versionNumber, fileName) => key('edrms', documentId, versionNumber, fileName);

/**
 * The records store from the settings. With EDRMS_ENCRYPTION=bao (or fake), files are encrypted
 * before they reach the store, with data keys wrapped by the KEK edrms-files in OpenBao
 * (packages/storage/README.md); EDRMS_ENCRYPTION=off (default) stores them as before.
 */
export function createStoreFromEnv() {
    const kind = envOneOf('EDRMS_STORAGE', ['s3', 'local', 'memory'], 's3');
    const store = kind === 'memory' ? createMemoryStore()
        : kind === 'local' ? createLocalStore({ root: env('EDRMS_LOCAL_DIR', './tmp/edrms-store') })
        : createS3Store({
            bucket: env('AWS_BUCKET_NAME'),
            region: env('AWS_BUCKET_REGION'),
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        });
    const keyring = keyringFromEnv({ setting: 'EDRMS_ENCRYPTION', defaultKeyName: 'edrms-files' });
    return keyring ? createEncryptingStore(store, keyring) : store;
}

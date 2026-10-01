import { env, envOneOf } from '@lrfe/common';
import { createMemoryStore, createLocalStore, createS3Store, storageKey as key } from '@lrfe/storage';

export { createMemoryStore, createLocalStore, createS3Store };

/** edrms/<documentId>/v<version>/<safe file name> */
export const storageKey = (documentId, versionNumber, fileName) => key('edrms', documentId, versionNumber, fileName);

export function createStoreFromEnv() {
    const kind = envOneOf('EDRMS_STORAGE', ['s3', 'local', 'memory'], 's3');
    if (kind === 'memory') return createMemoryStore();
    if (kind === 'local') return createLocalStore({ root: env('EDRMS_LOCAL_DIR', './tmp/edrms-store') });
    return createS3Store({
        bucket: env('AWS_BUCKET_NAME'),
        region: env('AWS_BUCKET_REGION'),
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
}

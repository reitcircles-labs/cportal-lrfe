import {env, envOneOf} from '@lrfe/common';
import {
  createEncryptingStore,
  createLocalStore,
  createMemoryStore,
  createS3Store,
  keyringFromEnv,
  storageKey,
} from '@lrfe/storage';

/** extracts/<extractId>/v1/extract.pdf: one file per extract, never replaced. */
export const pdfKeyOf = extractId =>
  storageKey('extracts', extractId, 1, 'extract.pdf');

/**
 * Where the sealed PDFs are kept, as edrms and intake keep their files (packages/storage):
 * EXTRACTS_STORAGE=local (a folder, EXTRACTS_LOCAL_DIR; the default), memory (tests, the e2e
 * stack) or s3 (the AWS_* settings). With EXTRACTS_ENCRYPTION=bao (or fake) each PDF is stored
 * encrypted under the vault key extracts-files (API-780). "Download again" gives the exact bytes
 * as issued.
 */
export function createPdfStoreFromEnv() {
  const store = plainStoreFromEnv();
  const keyring = keyringFromEnv({
    setting: 'EXTRACTS_ENCRYPTION',
    defaultKeyName: 'extracts-files',
  });
  return keyring ? createEncryptingStore(store, keyring) : store;
}

function plainStoreFromEnv() {
  const kind = envOneOf('EXTRACTS_STORAGE', ['s3', 'local', 'memory'], 'local');
  if (kind === 'memory') return createMemoryStore();
  if (kind === 'local') {
    return createLocalStore({
      root: env('EXTRACTS_LOCAL_DIR', './tmp/extracts-store'),
    });
  }
  return createS3Store({
    bucket: env('AWS_BUCKET_NAME'),
    region: env('AWS_BUCKET_REGION'),
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
}

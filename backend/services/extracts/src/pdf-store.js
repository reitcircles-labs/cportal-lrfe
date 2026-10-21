import {env, envOneOf} from '@lrfe/common';
import {
  createLocalStore,
  createMemoryStore,
  createS3Store,
  storageKey,
} from '@lrfe/storage';

/** extracts/<extractId>/v1/extract.pdf: one file per extract, never replaced. */
export const pdfKeyOf = extractId =>
  storageKey('extracts', extractId, 1, 'extract.pdf');

/**
 * Where the sealed PDFs are kept, as edrms and intake keep their files (packages/storage):
 * EXTRACTS_STORAGE=local (a folder, EXTRACTS_LOCAL_DIR; the default), memory (tests, the e2e
 * stack) or s3 (the AWS_* settings). "Download again" gives these exact bytes.
 */
export function createPdfStoreFromEnv() {
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

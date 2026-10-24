#!/usr/bin/env node
/**
 * The page-text back-fill (API-798): documents filed before the AI's page text was carried at
 * filing get it in the EDRMS, encrypted beside the PDF. It first moves page text still kept in
 * intake's database into its encrypted files (the service also does this at start). Safe to run
 * again: documents whose text the EDRMS has are left as they are.
 *
 *   npm run intake:backfill-text            (from backend/; uses services/intake/.env)
 *
 * Needs intake's database and document store (with its key service when INTAKE_ENCRYPTION=bao),
 * edrms running (EDRMS_URL) and the shared JWT_SECRET.
 */
// @lrfe/common reads the .env of the working directory (services/intake with npm run -w)
import {envOneOf} from '@lrfe/common';
import {setupFromEnv} from '../src/setup.js';

if (envOneOf('INTAKE_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
  console.error(
    'INTAKE_STORE=memory: there is nothing to back-fill. Run it against PostgreSQL.',
  );
  process.exit(2);
}
const {service, checks, sequelize} = setupFromEnv({
  logger: {info() {}, warn: m => console.warn(m)},
});
try {
  for (const check of checks) await check();
  const moved = await service.migrateTranscriptions();
  const result = await service.backfillFiledTranscriptions();
  console.log(
    `page text moved into intake's encrypted files: ${moved} document(s)`,
  );
  console.log(
    `filed documents: ${result.added} given their page text in the EDRMS, ` +
      `${result.present} already had it, ${result.withoutText} without page text, ` +
      `${result.failed.length} failed`,
  );
  for (const f of result.failed) {
    console.error(`  ${f.documentId}: ${f.error}`);
  }
  process.exitCode = result.failed.length ? 1 : 0;
} finally {
  await service.events.close?.();
  await sequelize?.close();
}

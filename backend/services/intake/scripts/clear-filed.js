#!/usr/bin/env node
/**
 * The back-fill of API-807: documents filed before intake cleared its copy at filing are cleared
 * now. For each filed document whose EDRMS copy is complete (version 1.0 with the same scan, and
 * its page text when intake has page text), intake removes its fields, notes, page text, model
 * answers and the scan's files; a document whose EDRMS copy is incomplete is left as it is. Safe
 * to run again: cleared documents are counted and skipped.
 *
 *   npm run intake:clear-filed            (from backend/; uses services/intake/.env)
 *
 * Needs intake's database and document store, edrms running (EDRMS_URL) and the shared JWT_SECRET.
 * Run `intake:backfill-text` first on an install from before API-798: until the EDRMS has a
 * document's page text, the document is not cleared.
 */
// @lrfe/common reads the .env of the working directory (services/intake with npm run -w)
import {envOneOf} from '@lrfe/common';
import {setupFromEnv} from '../src/setup.js';

if (envOneOf('INTAKE_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
  console.error(
    'INTAKE_STORE=memory: there is nothing to clear. Run it against PostgreSQL.',
  );
  process.exit(2);
}
const {service, checks, sequelize} = setupFromEnv({
  logger: {info() {}, warn: m => console.warn(m)},
});
try {
  for (const check of checks) await check();
  const result = await service.clearFiledDocuments();
  console.log(
    `filed documents: ${result.cleared} cleared, ` +
      `${result.incomplete} skipped (their EDRMS copy is incomplete), ` +
      `${result.alreadyCleared} already cleared, ${result.failed.length} failed`,
  );
  for (const f of result.failed) {
    console.error(`  ${f.documentId}: ${f.error}`);
  }
  process.exitCode = result.failed.length ? 1 : 0;
} finally {
  await service.events.close?.();
  await sequelize?.close();
}

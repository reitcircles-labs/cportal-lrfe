/**
 * Where the test stack runs. Ports differ from `npm run dev` (3500-3504, 4200), so the tests can
 * run while a developer copy is up. Override the base ports with E2E_API_PORT / E2E_WEB_PORT.
 */
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = join(E2E_DIR, '..');
export const BACKEND_DIR = join(REPO_DIR, 'backend');
export const ANGULAR_DIR = join(REPO_DIR, 'angular-app');
/** Scratch space for the running stack: emails written by identity, service working dirs. Gitignored. */
export const STACK_DIR = join(E2E_DIR, '.stack');
export const MAIL_DIR = join(STACK_DIR, 'mail');
/**
 * E2E_STORE_DIR: the stored files and their OpenBao, kept between runs (the test register with
 * its files, backend/scripts/scale, API-810). The files are in `files/`, an encrypted directory.
 */
export const STORE_DIR = process.env.E2E_STORE_DIR
  ? resolve(process.env.E2E_STORE_DIR)
  : null;
/** E2E_BAO=real: the throwaway OpenBao's data, config and the services' AppRole files (kept with E2E_STORE_DIR). */
export const BAO_DIR = STORE_DIR
  ? join(STORE_DIR, 'bao')
  : join(STACK_DIR, 'bao');
/** Where the services store files on PostgreSQL: edrms/, intake/, extracts/. */
export const FILES_DIR = STORE_DIR
  ? join(STORE_DIR, 'files')
  : join(STACK_DIR, 'files');

const apiBase = Number(process.env.E2E_API_PORT || 3600);
export const PORTS = {
  gateway: apiBase,
  identity: apiBase + 1,
  edrms: apiBase + 2,
  bpm: apiBase + 3,
  intake: apiBase + 4,
  nats: apiBase + 5,
  postgres: apiBase + 6,
  bao: apiBase + 7, // E2E_BAO=real; its cluster port is the next one
  'land-records': apiBase + 9,
  audit: apiBase + 10,
  docs: apiBase + 11, // the API docs container (npm run test:docker)
  extracts: apiBase + 12,
  web: Number(process.env.E2E_WEB_PORT || 4300),
};
export const WEB_URL = `http://localhost:${PORTS.web}`;
export const GATEWAY_URL = `http://localhost:${PORTS.gateway}`;

/**
 * How stored files are encrypted in this run (API-795: always, unless E2E_BAO=off on purpose):
 * fake (in memory, the default), real (a throwaway OpenBao, the default with E2E_DB=postgres) or
 * docker (the containers' own OpenBao, npm run test:docker). Set in the environment, so the stack
 * and the test workers agree.
 */
export const E2E_BAO =
  process.env.E2E_BAO ||
  (process.env.E2E_DOCKER
    ? 'docker'
    : process.env.E2E_DB === 'postgres'
      ? 'real'
      : 'fake');
process.env.E2E_BAO = E2E_BAO;

/** The secret the stack's services sign and check tokens with (JWT_SECRET); the load tests sign their own. */
export const JWT_SECRET = 'e2e-only-jwt-secret-not-used-anywhere-else';

/** Password of every seeded demo user (identity's SEED_DEMO_PASSWORD). The stack is in memory only. */
export const DEMO_PASSWORD = 'e2e-demo-password-2026';

/**
 * The organisation of the test install in containers (API-712, start-docker.mjs): other texts than
 * the defaults, so the tests see the site's settings arrive in every place; a quote and a backslash
 * check the escaping. The tests' own stack uses the defaults (angular-app/public/config.json).
 */
export const E2E_ORG = {
  name: 'Land Titles Office',
  subtitle: 'Test "Republic" \\ e2e',
  parent: 'Ministry of Test Lands',
  place: 'Testville',
};

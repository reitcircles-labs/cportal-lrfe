/**
 * Where the test stack runs. Ports differ from `npm run dev` (3500-3504, 4200), so the tests can
 * run while a developer copy is up. Override the base ports with E2E_API_PORT / E2E_WEB_PORT.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = join(E2E_DIR, '..');
export const BACKEND_DIR = join(REPO_DIR, 'backend');
export const ANGULAR_DIR = join(REPO_DIR, 'angular-app');
/** Scratch space for the running stack: emails written by identity, service working dirs. Gitignored. */
export const STACK_DIR = join(E2E_DIR, '.stack');
export const MAIL_DIR = join(STACK_DIR, 'mail');

const apiBase = Number(process.env.E2E_API_PORT || 3600);
export const PORTS = {
    gateway: apiBase,
    identity: apiBase + 1,
    edrms: apiBase + 2,
    bpm: apiBase + 3,
    intake: apiBase + 4,
    nats: apiBase + 5,
    postgres: apiBase + 6,
    web: Number(process.env.E2E_WEB_PORT || 4300)
};
export const WEB_URL = `http://localhost:${PORTS.web}`;
export const GATEWAY_URL = `http://localhost:${PORTS.gateway}`;

/** Password of every seeded demo user (identity's SEED_DEMO_PASSWORD). The stack is in memory only. */
export const DEMO_PASSWORD = 'e2e-demo-password-2026';

import {defineConfig} from '@playwright/test';
import {E2E_DIR, GATEWAY_URL} from './stack/config.mjs';

/**
 * The shipping product's end-to-end tests (CB-28, npm run test:shipping): the backend stack in
 * shipping mode (stack/start-backend.mjs with E2E_DOMAIN=shipping: every service on the shipping
 * pack, shipping-records instead of land-records), and the specs in tests-shipping/, which call
 * the API through the gateway. No web app is started. E2E_DB=postgres runs it on PostgreSQL, as
 * the main suite; E2E_REUSE=1 uses a stack already running in shipping mode.
 */
const reuse = !!process.env.E2E_REUSE;

export default defineConfig({
  testDir: './tests-shipping',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // the live progress file (API-813), as the main suite: tail -f e2e/.progress/progress.log
  reporter: [['list'], ['./support/progress-reporter.ts']],
  outputDir: './test-results/shipping',
  use: {baseURL: GATEWAY_URL},
  webServer: {
    command: 'node stack/start-backend.mjs',
    cwd: E2E_DIR,
    env: {E2E_DOMAIN: 'shipping'},
    url: `${GATEWAY_URL}/health`,
    reuseExistingServer: reuse,
    timeout: 120_000,
    // let it stop the services and its PostgreSQL (E2E_DB=postgres), which runs detached
    gracefulShutdown: {signal: 'SIGTERM', timeout: 15_000},
    stdout: 'pipe',
  },
});

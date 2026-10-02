import { defineConfig, devices } from '@playwright/test';
import { ANGULAR_DIR, E2E_DIR, GATEWAY_URL, PORTS, WEB_URL } from './stack/config.mjs';

// E2E_REUSE=1: use a test stack that is already running (node stack/start-backend.mjs, and ng
// serve on the web port) instead of starting one. Without it, a busy port is an error, so a
// developer's own copy is never tested by mistake.
const reuse = !!process.env.E2E_REUSE;

export default defineConfig({
    testDir: './tests',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: WEB_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure'
    },
    projects: [
        { name: 'setup', testMatch: /auth\.setup\.ts/ },
        // channel 'chromium': the full browser in headless mode, which (unlike the default headless shell)
        // has the PDF viewer, so scans show on Verify and Documents as they do for users
        { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' }, dependencies: ['setup'] }
    ],
    webServer: [
        {
            command: 'node stack/start-backend.mjs',
            cwd: E2E_DIR,
            url: `${GATEWAY_URL}/health`,
            reuseExistingServer: reuse,
            timeout: 90_000,
            stdout: 'pipe'
        },
        {
            command: `npx ng serve --port ${PORTS.web} --proxy-config ${E2E_DIR}/stack/proxy.e2e.mjs`,
            cwd: ANGULAR_DIR,
            url: WEB_URL,
            reuseExistingServer: reuse,
            timeout: 180_000,
            env: { NG_CLI_ANALYTICS: 'false' }
        }
    ]
});

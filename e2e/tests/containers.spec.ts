/**
 * The application in containers (API-700): only with E2E_DOCKER=1 (npm run test:docker), where the
 * web app is the nginx container of angular-app/Dockerfile. What that container adds to the app:
 * every page is the app, /api/... reaches the gateway, the security headers, index.html never
 * cached and the build files cached for good; and a user signs in and works through it.
 */
import { expect, test } from '@playwright/test';
import { signInAs } from '../support/auth';
import { userByRole } from '../support/catalogue';
import { evidence } from '../support/evidence';

test.skip(!process.env.E2E_DOCKER, 'only against the containers (npm run test:docker)');

test('the web container serves the app, passes /api to the gateway, and sends the security and cache headers', { tag: ['@API-700'] }, async ({ request }) => {
    const index = await request.get('/');
    expect(index.status()).toBe(200);
    expect(index.headers()['cache-control']).toBe('no-store');
    expect(index.headers()['x-frame-options']).toBe('SAMEORIGIN');
    expect(index.headers()['x-content-type-options']).toBe('nosniff');
    expect(index.headers()['referrer-policy']).toBe('same-origin');

    // the build files have a content hash in their name: cached for a year
    const main = (await index.text()).match(/src="(main-[A-Z0-9]+\.js)"/)?.[1];
    expect(main, 'the main script in index.html').toBeTruthy();
    const script = await request.get(`/${main}`);
    expect(script.status()).toBe(200);
    expect(script.headers()['cache-control']).toContain('immutable');

    // any other path is the app (its routes are after #)
    const other = await request.get('/some/path');
    expect(other.status()).toBe(200);
    expect(await other.text()).toContain('<app-root');

    // /api/... goes to the gateway unchanged
    const wallet = await request.get('/api/audit/anchoring/wallet');
    expect(wallet.status()).toBe(200);
    expect(await wallet.json()).toHaveProperty('address');
    expect((await request.get('/healthz')).status()).toBe(200);
});

test('a user signs in through the containers and works in the portal', { tag: ['@API-700'] }, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
    const signIn = await context.newPage();
    await signIn.goto('/#/login');
    await expect(signIn.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await evidence(signIn, 'API-700', 'The sign-in page, served by the web container');
    await signIn.close();

    // the app restores a session when it loads: a page of its own for the signed-in user
    const page = await context.newPage();
    await signInAs(page, userByRole('adm').email, '/admin/users');
    await expect(page.getByRole('button', { name: 'Invite user' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: userByRole('rev').email })).toBeVisible();
    await evidence(page, 'API-700', 'Signed in as the system administrator: Users, read through the gateway and identity containers from PostgreSQL');

    await page.getByRole('complementary', { name: 'Main navigation' }).getByRole('link', { name: 'Anchoring health' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Anchoring health' }).last()).toBeVisible();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await evidence(page, 'API-700', 'Anchoring health from the audit container: the wallet, the blockchain connection, the next anchoring');
    await context.close();
});

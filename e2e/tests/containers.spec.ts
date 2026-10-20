/**
 * The application in containers (API-700): only with E2E_DOCKER=1 (npm run test:docker), where the
 * web app is the nginx container of angular-app/Dockerfile. What that container adds to the app:
 * every page is the app, /api/... reaches the gateway, the security headers, index.html never
 * cached and the build files cached for good; and a user signs in and works through it.
 */
import {expect, test} from '@playwright/test';
import {adminApi, appPath, invitationEmail, unique} from '../support/admin';
import {signInAs} from '../support/auth';
import {userByRole} from '../support/catalogue';
import {evidence} from '../support/evidence';
import {E2E_ORG, PORTS} from '../stack/config.mjs';

test.skip(
  !process.env.E2E_DOCKER,
  'only against the containers (npm run test:docker)',
);

test(
  'the web container serves the app, passes /api to the gateway, and sends the security and cache headers',
  {tag: ['@API-700']},
  async ({request}) => {
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
  },
);

test(
  'a user signs in through the containers and works in the portal',
  {tag: ['@API-700']},
  async ({browser}) => {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: {width: 1440, height: 900},
    });
    const signIn = await context.newPage();
    await signIn.goto('/#/login');
    await expect(signIn.getByRole('button', {name: 'Sign in'})).toBeVisible();
    await evidence(
      signIn,
      'API-700',
      'The sign-in page, served by the web container',
    );
    await signIn.close();

    // the app restores a session when it loads: a page of its own for the signed-in user
    const page = await context.newPage();
    await signInAs(page, userByRole('adm').email, '/admin/users');
    await expect(page.getByRole('button', {name: 'Invite user'})).toBeVisible();
    await expect(
      page.getByRole('row').filter({hasText: userByRole('rev').email}),
    ).toBeVisible();
    await evidence(
      page,
      'API-700',
      'Signed in as the system administrator: Users, read through the gateway and identity containers from PostgreSQL',
    );

    await page
      .getByRole('complementary', {name: 'Main navigation'})
      .getByRole('link', {name: 'Anchoring health'})
      .click();
    await expect(
      page.getByRole('heading', {level: 1, name: 'Anchoring health'}).last(),
    ).toBeVisible();
    await expect(page.getByText('Connected', {exact: true})).toBeVisible();
    await evidence(
      page,
      'API-700',
      'Anchoring health from the audit container: the wallet, the blockchain connection, the next anchoring',
    );
    await context.close();
  },
);

test(
  "the organisation's name and texts come from the site's settings, everywhere they are shown",
  {tag: ['@API-712']},
  async ({browser, playwright, request}) => {
    const fullName = `${E2E_ORG.name} · ${E2E_ORG.subtitle}`;

    // written by the web container from the settings when it started, escaped, never cached
    const config = await request.get('/config.json');
    expect(config.headers()['cache-control']).toBe('no-store');
    expect(await config.json()).toEqual({
      orgName: E2E_ORG.name,
      orgSubtitle: E2E_ORG.subtitle,
      orgParent: E2E_ORG.parent,
      orgPlace: E2E_ORG.place,
    });

    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: {width: 1440, height: 900},
    });
    const page = await context.newPage();
    await page.goto('/#/login');
    await expect(page.locator('.brand')).toContainText(E2E_ORG.name);
    await expect(page.locator('.brand')).toContainText(E2E_ORG.parent);
    await expect(page).toHaveTitle(`${E2E_ORG.name} · Land records intake`);
    await expect(page.getByText(/Namibia/)).toHaveCount(0);
    await evidence(
      page,
      'API-712',
      "Sign-in: the organisation's name and parent body from the site's settings",
    );

    await page.goto('/#/check-a-proof');
    await expect(page.getByText(fullName, {exact: true})).toBeVisible();
    await expect(
      page.getByText(`Were you given a proof file by the ${E2E_ORG.name}?`),
    ).toBeVisible();

    // an invitation: the email and the activation page
    const admin = await adminApi(playwright, test.info().project.use.baseURL!);
    const email = `e2e.org.${unique()}@example.com`;
    const {offices} = await (
      await admin.api.get('/api/offices', {headers: admin.headers})
    ).json();
    const invited = await admin.api.post('/api/users', {
      headers: admin.headers,
      data: {
        name: 'E2E Org Invitee',
        email,
        officeId: offices[0].id,
        roles: ['rec'],
      },
    });
    expect(invited.status(), await invited.text()).toBe(201);
    const mail = await invitationEmail(email);
    expect(mail.text).toContain(E2E_ORG.name);
    expect(mail.text).toContain(E2E_ORG.subtitle);
    expect(mail.text).not.toContain('Namibia');
    await page.goto(appPath(mail.link));
    await expect(page.getByText(fullName, {exact: true})).toBeVisible();
    await evidence(
      page,
      'API-712',
      'Invitation: the activation page with the full name from the settings',
    );

    // the authenticator app's entry, offered at the first sign-in
    const accepted = await admin.api.post('/api/invitations/accept', {
      data: {
        token: new URL(mail.link.replace('/#/', '/')).searchParams.get('token'),
        password: 'e2e org invitee password 2026',
      },
    });
    expect(accepted.status(), await accepted.text()).toBe(200);
    const login = await (
      await admin.api.post('/api/auth/login', {
        data: {email, password: 'e2e org invitee password 2026'},
      })
    ).json();
    expect(login.next).toBe('mfa-enroll');
    expect(new URL(login.otpauthUrl).searchParams.get('issuer')).toBe(fullName);
    await admin.dispose();

    // signed in: the side bar and the dashboard's crumb
    const signedIn = await context.newPage();
    await signInAs(signedIn, userByRole('sup').email, '/');
    const brand = signedIn
      .getByRole('complementary', {name: 'Main navigation'})
      .locator('.brand');
    await expect(brand).toContainText(E2E_ORG.name);
    await expect(brand).toContainText(E2E_ORG.subtitle);
    await expect(
      signedIn.getByText(`${E2E_ORG.name} · ${E2E_ORG.place}`).first(),
    ).toBeVisible();
    await evidence(
      signedIn,
      'API-712',
      "Signed in: the side bar and the dashboard with the site's organisation",
    );
    await context.close();
  },
);

test(
  'the API docs container serves Swagger UI and passes "Try it out" to the gateway and to a service',
  {tag: ['@API-714']},
  async ({playwright, browser}) => {
    const docs = await playwright.request.newContext({
      baseURL: `http://localhost:${PORTS.docs}`,
    });
    const page = await docs.get('/');
    expect(page.status()).toBe(200);
    expect(await page.text()).toContain('SwaggerUIBundle');

    // the specs, pointed back at the docs server
    const all = await docs.get('/specs/gateway.yaml');
    expect(all.status()).toBe(200);
    expect(await all.text()).toMatch(/^servers:\n {2}- url: \/\n/m);
    expect(await (await docs.get('/specs/identity.yaml')).text()).toMatch(
      /^servers:\n {2}- url: \/direct\/identity\n/m,
    );

    // through the gateway container, and straight to a service's container
    const wallet = await docs.get('/api/audit/anchoring/wallet');
    expect(wallet.status()).toBe(200);
    expect(await wallet.json()).toHaveProperty('address');
    // an address no user has: identity answers 401, and no real account counts a failed sign-in
    const login = await docs.post('/direct/identity/auth/login', {
      data: {
        email: 'nobody.docs-check@example.org',
        password: 'not a password',
      },
    });
    expect(login.status(), 'identity answers straight from its container').toBe(
      401,
    );
    await docs.dispose();

    // the page itself (Swagger UI comes from a public CDN; shown only when this machine reaches it)
    const context = await browser.newContext({
      viewport: {width: 1440, height: 900},
    });
    const ui = await context.newPage();
    await ui.goto(`http://localhost:${PORTS.docs}/`);
    const loaded = await ui
      .locator('.swagger-ui .info .title')
      .first()
      .waitFor({timeout: 15_000})
      .then(
        () => true,
        () => false,
      );
    if (loaded) {
      await evidence(
        ui,
        'API-714',
        'The API docs container: Swagger UI with every endpoint through the gateway',
      );
    }
    await context.close();
  },
);

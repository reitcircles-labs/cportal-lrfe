/**
 * Sessions and two-factor sign-in (CB-103), in the land registry app: a session records whether
 * it was opened with 2FA.
 *
 * - "Reset 2FA" ends the user's sessions at once: the access and refresh tokens from before are
 *   refused by every service.
 * - Once an administrator makes 2FA mandatory, a session opened with the password only cannot be
 *   renewed: the user signs in again, with a setup code and the authenticator.
 * - A session opened with 2FA keeps working.
 *
 * Making 2FA optional for a while changes how every user without an authenticator signs in and
 * accepts an invitation, so this spec runs alone, after all the others (its own project in
 * playwright.config.ts), one test at a time, and puts the policy back as it found it. Each test
 * uses users of its own, never a shared demo user.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import {apiSignIn, codeFor} from '../support/auth';
import {
  NEW_USER_PASSWORD,
  adminApi,
  appPath,
  createUser,
  inviteLink,
  unique,
  type AdminApi,
  type NewUser,
} from '../support/admin';

const tag = {tag: '@CB-103'};

/** What a test opened (request contexts, the admin's session), closed after it even if it fails. */
const opened: Array<{dispose: () => Promise<void>}> = [];

test.afterEach(async () => {
  for (const context of opened.splice(0)) {
    await context.dispose();
  }
});

test.describe.configure({mode: 'serial'});

/** The site's security policies, as GET /api/policies answers them. */
interface Policies {
  mfa: boolean;
  eid: boolean;
  ipAllow: boolean;
  timeout: number;
  maxSessionAge?: number;
  fourEyes: boolean;
}

/**
 * An administrator's API session, for the test's own users.
 * @param playwright the Playwright fixture
 * @return the session
 */
function admin(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<AdminApi> {
  return adminApi(playwright, test.info().project.use.baseURL!);
}

/**
 * Whether two-factor sign-in is required now.
 * @param api the administrator's session
 * @return the policy
 */
async function twoFactorRequired(api: AdminApi): Promise<boolean> {
  const res = await api.api.get('/api/policies', {headers: api.headers});
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).policies as Policies).mfa;
}

/**
 * Saves the two-factor policy, the other policies unchanged.
 * @param api the administrator's session
 * @param mfa whether two-factor sign-in is required
 */
async function requireTwoFactor(api: AdminApi, mfa: boolean): Promise<void> {
  const current = await api.api.get('/api/policies', {headers: api.headers});
  expect(current.status(), await current.text()).toBe(200);
  const {policies} = (await current.json()) as {policies: Policies};
  const res = await api.api.put('/api/policies', {
    headers: api.headers,
    data: {
      policies: {
        mfa,
        eid: policies.eid,
        ipAllow: policies.ipAllow,
        timeout: policies.timeout,
        maxSessionAge: policies.maxSessionAge,
        fourEyes: policies.fourEyes,
      },
    },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/**
 * Runs `body` with two-factor sign-in optional, then puts the policy back as it was.
 * @param api the administrator's session
 * @param body what to do while 2FA is optional
 * @return what `body` returns
 */
async function whileOptional<T>(
  api: AdminApi,
  body: () => Promise<T>,
): Promise<T> {
  const before = await twoFactorRequired(api);
  await requireTwoFactor(api, false);
  try {
    return await body();
  } finally {
    await requireTwoFactor(api, before);
  }
}

/**
 * Invites a user and activates the account with the password only, as while 2FA is optional:
 * the user has no authenticator.
 * @param api the administrator's session
 * @param label part of the name and email
 * @return the user
 */
async function userWithoutAuthenticator(
  api: AdminApi,
  label: string,
): Promise<NewUser> {
  const id = unique();
  const name = `E2E ${label} ${id}`;
  const email = `e2e.${label}.${id}@deeds.gov.na`;
  const {offices} = await (
    await api.api.get('/api/offices', {headers: api.headers})
  ).json();
  const wdh = offices.find((o: {code: string}) => o.code === 'WDH');
  const res = await api.api.post('/api/users', {
    headers: api.headers,
    data: {name, email, officeId: wdh.id, roles: ['rec']},
  });
  expect(res.status(), await res.text()).toBe(201);
  const token = new URL(
    appPath(await inviteLink(email)).replace('/#/', '/'),
    'http://x',
  ).searchParams.get('token');
  const accepted = await api.api.post('/api/invitations/accept', {
    data: {token, password: NEW_USER_PASSWORD},
  });
  expect(accepted.status(), await accepted.text()).toBe(200);
  expect(
    (await accepted.json()).next,
    'no authenticator while 2FA is optional',
  ).toBeUndefined();
  return {id: (await res.json()).user.id, name, email, roles: ['rec']};
}

/**
 * The password step on the sign-in screen.
 * @param page the page
 * @param email the user's email
 */
async function enterPassword(page: Page, email: string): Promise<void> {
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(NEW_USER_PASSWORD);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
}

/**
 * Reloads the page and answers the status of the session renewal it makes.
 * @param page the page
 * @return the status of POST /api/auth/refresh
 */
async function reloadRenewing(page: Page): Promise<number> {
  const renewed = page.waitForResponse(r =>
    r.url().endsWith('/api/auth/refresh'),
  );
  await page.reload();
  return (await renewed).status();
}

/**
 * Renews a session held in `request`'s cookie jar.
 * @param request the session's request context
 * @return the status
 */
async function renew(request: APIRequestContext): Promise<number> {
  return (await request.post('/api/auth/refresh')).status();
}

test(
  "after an administrator resets 2FA, the user's access and refresh tokens from before are refused",
  tag,
  async ({playwright}) => {
    const base = test.info().project.use.baseURL!;
    const api = await admin(playwright);
    opened.push(api);
    const user = await createUser(api, ['rec'], 'resettoken');
    const theirs = await playwright.request.newContext({baseURL: base});
    opened.push(theirs);
    const headers = {
      authorization: `Bearer ${await apiSignIn(theirs, user.email, NEW_USER_PASSWORD)}`,
    };
    expect((await theirs.get('/api/documents', {headers})).status()).toBe(200);

    const reset = await api.api.post(`/api/users/${user.id}/mfa-reset`, {
      headers: api.headers,
    });
    expect(reset.status(), await reset.text()).toBe(200);
    expect(await renew(theirs), 'renewing is refused').toBe(401);
    // every service: identity, edrms, bpm, intake (the revocation reaches them within milliseconds)
    for (const path of [
      '/api/auth/me',
      '/api/documents',
      '/api/tasks',
      '/api/intake/catalogue',
    ]) {
      await expect
        .poll(async () => (await theirs.get(path, {headers})).status(), {
          message: `${path} with the token from before the reset`,
          timeout: 5000,
        })
        .toBe(401);
    }
  },
);

test(
  'after 2FA becomes mandatory, a session opened with the password only cannot be renewed and the user signs in again with 2FA',
  tag,
  async ({page, playwright}) => {
    const api = await admin(playwright);
    opened.push(api);
    const user = await whileOptional(api, async () => {
      const created = await userWithoutAuthenticator(api, 'passwordonly');
      await enterPassword(page, created.email);
      // no code step: the password alone opened the session
      await expect(page.locator('aside.sidebar')).toBeVisible();
      expect(await reloadRenewing(page), 'renewed while 2FA is optional').toBe(
        200,
      );
      await expect(page.locator('aside.sidebar')).toBeVisible();
      return created;
    });
    expect(await twoFactorRequired(api), '2FA is mandatory again').toBe(true);

    // the next renewal is refused and the app goes back to the sign-in screen
    expect(await reloadRenewing(page), 'renewal after the switch').toBe(401);
    await expect(page).toHaveURL(/#\/login/);

    // signing in again takes a setup code and the authenticator
    await enterPassword(page, user.email);
    await expect(
      page.getByRole('heading', {name: 'Enter your setup code'}),
    ).toBeVisible();
    const given = await api.api.post(`/api/users/${user.id}/setup-code`, {
      headers: api.headers,
    });
    expect(given.status(), await given.text()).toBe(200);
    await page.getByLabel('Setup code').fill((await given.json()).setupCode);
    await page.getByRole('button', {name: 'Continue'}).click();
    await expect(
      page.getByRole('heading', {name: 'Set up your authenticator'}),
    ).toBeVisible();
    await page.getByText("Can't scan? Type the setup key instead").click();
    const key = (await page.locator('code.key').textContent())!.replace(
      /\s/g,
      '',
    );
    await page.getByLabel(/code/i).last().fill(codeFor(key));
    await page.getByRole('button', {name: 'Verify and sign in'}).click();
    await expect(page.locator('aside.sidebar')).toBeVisible();

    // the new session, opened with 2FA, renews as usual
    expect(await reloadRenewing(page), 'renewal of the new session').toBe(200);
    await expect(page.locator('aside.sidebar')).toBeVisible();
  },
);

test(
  'a session opened with 2FA keeps being renewed after 2FA becomes mandatory',
  tag,
  async ({playwright}) => {
    const base = test.info().project.use.baseURL!;
    const api = await admin(playwright);
    opened.push(api);
    const user = await createUser(api, ['rec'], 'withcode');
    const theirs = await playwright.request.newContext({baseURL: base});
    opened.push(theirs);
    await whileOptional(api, async () => {
      const headers = {
        authorization: `Bearer ${await apiSignIn(theirs, user.email, NEW_USER_PASSWORD)}`,
      };
      expect((await theirs.get('/api/documents', {headers})).status()).toBe(
        200,
      );
    });
    expect(await twoFactorRequired(api), '2FA is mandatory again').toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(await renew(theirs), `renewal ${i + 1}`).toBe(200);
    }
    const me = await theirs.post('/api/auth/refresh');
    expect(me.status()).toBe(200);
    const token = (await me.json()).accessToken;
    expect(
      (
        await theirs.get('/api/documents', {
          headers: {authorization: `Bearer ${token}`},
        })
      ).status(),
    ).toBe(200);
  },
);

/**
 * The sign-in screen: password, authenticator code, first-time enrolment, refusals, sign-out.
 */
import {
  expect,
  test,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import {
  MATRIX_USERS,
  MFA_UI_USER,
  demoUser,
  userByRole,
} from '../support/catalogue';
import {apiSignIn, codeFor, secretOf, wrongCodeFor} from '../support/auth';
import {NEW_USER_PASSWORD, adminApi, createUser} from '../support/admin';
import {DEMO_PASSWORD} from '../stack/config.mjs';

async function enterPassword(
  page: Page,
  email: string,
  password = DEMO_PASSWORD,
) {
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
}

async function enterCode(page: Page, code: string) {
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', {name: 'Verify and sign in'}).click();
}

for (const user of MATRIX_USERS) {
  test(`${user.label} signs in with password and code, and lands on ${user.home}`, async ({
    page,
  }) => {
    await enterPassword(page, user.email);
    await expect(
      page.getByRole('heading', {name: 'Enter your code'}),
    ).toBeVisible();
    await enterCode(page, codeFor(secretOf(user.email)));
    // Verify adds the document it opens (?doc=) when its queue is not empty
    await expect(page).toHaveURL(new RegExp(`#${user.home}(\\?.*)?$`));
    await expect(page.locator('aside.sidebar')).toContainText(user.name);
    // Opening Verify took that document for review: leave it, so the review lock is released
    // and another test's document is not held for the lock's 30 minutes (API-664)
    if (/[?&]doc=/.test(page.url())) {
      // (no release when it could only look: the document was not ready, or someone else had it)
      const released = page
        .waitForResponse(
          r => r.url().includes('/release') && r.request().method() === 'POST',
          {timeout: 5000},
        )
        .catch(() => {});
      await page.goto('/#/documents');
      await expect(page.locator('header.topbar h1')).toHaveText(
        'Documents (EDRMS)',
      );
      await released;
    }
  });
}

test('a wrong password is refused', async ({page}) => {
  await enterPassword(page, userByRole('scan').email, 'not-the-password');
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password');
});

test('a wrong authenticator code is refused', async ({page}) => {
  const user = userByRole('rev');
  await enterPassword(page, user.email);
  const good = codeFor(secretOf(user.email));
  await enterCode(page, good === '000000' ? '111111' : '000000');
  await expect(page.getByRole('alert')).toHaveText(
    'Invalid authenticator code',
  );
});

test('a suspended user cannot sign in', async ({page}) => {
  await enterPassword(page, demoUser('Suspended').email);
  await expect(page.getByRole('alert')).toContainText('suspended');
});

test('an invited user who has not activated cannot sign in with a password', async ({
  page,
}) => {
  await enterPassword(page, demoUser('Invited').email);
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password');
});

test('first sign-in sets up the authenticator from the setup key', async ({
  page,
  playwright,
}) => {
  // Start from "not enrolled" whatever an earlier run did: an administrator resets the user's MFA.
  const admin = await playwright.request.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const token = await apiSignIn(admin, userByRole('adm').email);
  const headers = {authorization: `Bearer ${token}`};
  const {users} = await (await admin.get('/api/users', {headers})).json();
  const target = users.find((u: {email: string}) => u.email === MFA_UI_USER);
  expect(
    (await admin.post(`/api/users/${target.id}/mfa-reset`, {headers})).status(),
  ).toBe(200);
  await admin.dispose();

  await enterPassword(page, MFA_UI_USER);
  await expect(
    page.getByRole('heading', {name: 'Set up your authenticator'}),
  ).toBeVisible();
  await expect(page.getByRole('img', {name: /QR code/})).toBeVisible();
  await page.getByText("Can't scan? Type the setup key instead").click();
  const key = (await page.locator('code.key').textContent())!.replace(
    /\s/g,
    '',
  );
  expect(key).toMatch(/^[A-Z2-7]{32}$/);
  await enterCode(page, codeFor(key));
  await expect(page).toHaveURL(/#\/capture$/);
});

test('the session survives a page reload, and signing out ends it', async ({
  page,
}) => {
  const user = userByRole('rec');
  await enterPassword(page, user.email);
  await enterCode(page, codeFor(secretOf(user.email)));
  await expect(page).toHaveURL(/#\/link$/);

  await page.reload();
  await expect(page).toHaveURL(/#\/link$/);
  await expect(page.locator('aside.sidebar')).toContainText(user.name);

  await page.getByRole('button', {name: 'Sign out'}).click();
  await expect(page).toHaveURL(/#\/login/);
  await page.goto('/#/link');
  await expect(page).toHaveURL(/#\/login\?returnUrl=%2Flink/);
});

test(
  'an active user keeps working: each reload renews the session as before (CB-100)',
  {tag: '@CB-100'},
  async ({page}) => {
    // The maximum session age (12 h by default) is far off, so nothing changes for an active user.
    // A session older than the maximum age is refused by the unit tests, where time can be moved on.
    const user = userByRole('rec');
    await enterPassword(page, user.email);
    await enterCode(page, codeFor(secretOf(user.email)));
    await expect(page).toHaveURL(/#\/link$/);

    for (let i = 0; i < 3; i++) {
      const renewed = page.waitForResponse(r =>
        r.url().endsWith('/api/auth/refresh'),
      );
      await page.reload();
      expect((await renewed).status()).toBe(200);
      await expect(page).toHaveURL(/#\/link$/);
      await expect(page.locator('aside.sidebar')).toContainText(user.name);
    }
  },
);

test.describe('wrong authenticator codes (CB-101)', {tag: '@CB-101'}, () => {
  /** A user of the test's own: the per-user count of wrong codes must not touch the demo users. */
  async function freshUser(playwright: PlaywrightWorkerArgs['playwright']) {
    const admin = await adminApi(playwright, test.info().project.use.baseURL!);
    const user = await createUser(admin, ['rec'], 'codes');
    await admin.dispose();
    return user;
  }

  test('a wrong code once or twice, then the right one, signs in as before', async ({
    page,
    playwright,
  }) => {
    const user = await freshUser(playwright);
    await enterPassword(page, user.email, NEW_USER_PASSWORD);
    for (let i = 0; i < 2; i++) {
      await enterCode(page, wrongCodeFor(secretOf(user.email)));
      // The screen empties the field once the server has answered; the alert may still be the last one.
      await expect(page.getByLabel('6-digit code')).toHaveValue('');
      await expect(page.getByRole('alert')).toHaveText(
        'Invalid authenticator code',
      );
    }
    await enterCode(page, codeFor(secretOf(user.email)));
    await expect(page.locator('aside.sidebar')).toContainText(user.name);
  });

  test('after five wrong codes this sign-in is refused, and signing in again works', async ({
    page,
    playwright,
  }) => {
    const user = await freshUser(playwright);
    await enterPassword(page, user.email, NEW_USER_PASSWORD);
    for (let i = 0; i < 5; i++) {
      await enterCode(page, wrongCodeFor(secretOf(user.email)));
      // The screen empties the field once the server has answered; the alert may still be the last one.
      await expect(page.getByLabel('6-digit code')).toHaveValue('');
      await expect(page.getByRole('alert')).toHaveText(
        'Invalid authenticator code',
      );
    }
    await enterCode(page, codeFor(secretOf(user.email)));
    await expect(page.getByRole('alert')).toHaveText(
      'Too many wrong codes: sign in again',
    );
    await expect(page.locator('aside.sidebar')).toHaveCount(0);

    await page.getByRole('button', {name: 'Use a different account'}).click();
    await enterPassword(page, user.email, NEW_USER_PASSWORD);
    await enterCode(page, codeFor(secretOf(user.email)));
    await expect(page.locator('aside.sidebar')).toContainText(user.name);
  });
});

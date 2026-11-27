/**
 * Setting up the authenticator only with a second proof (CB-102), in the land registry app: the
 * invitation link for a new user, or a one-time setup code from an administrator for anyone else.
 * The password alone never shows a QR code.
 *
 * The setup codes are read from the administrator's API answers (POST /api/users/:id/mfa-reset and
 * POST /api/users/:id/setup-code: { setupCode }), as an administrator reads them from the screen;
 * no mailbox is needed. Each test uses a user of its own, never a shared demo user.
 */
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import {userByRole} from '../support/catalogue';
import {codeFor, freshCodeFor, secretOf, signedInPage} from '../support/auth';
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
import {evidence} from '../support/evidence';

const ADMIN = userByRole('adm');
const tag = {tag: '@CB-102'};

/** A setup code as the administrator sees it. */
const SETUP_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

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
 * Resets a user's authenticator through the API.
 * @param api the administrator's session
 * @param user the user
 * @return the one-time setup code of the answer
 */
async function resetTwoFactor(api: AdminApi, user: NewUser): Promise<string> {
  const res = await api.api.post(`/api/users/${user.id}/mfa-reset`, {
    headers: api.headers,
  });
  expect(res.status(), await res.text()).toBe(200);
  const {setupCode} = await res.json();
  expect(setupCode).toMatch(SETUP_CODE);
  return setupCode;
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
 * The setup code on the sign-in screen's step 2.
 * @param page the page
 * @param setupCode the code
 */
async function enterSetupCode(page: Page, setupCode: string): Promise<void> {
  await page.getByLabel('Setup code').fill(setupCode);
  await page.getByRole('button', {name: 'Continue'}).click();
}

/**
 * The QR step: reads the setup key and sends the authenticator's code.
 * @param page the page
 * @param button the button that sends the code
 * @param caption the evidence screenshot's caption for this step, when one is taken
 * @return the authenticator secret
 */
async function setUpAuthenticator(
  page: Page,
  button: string,
  caption?: string,
): Promise<string> {
  await expect(
    page.getByRole('heading', {name: 'Set up your authenticator'}),
  ).toBeVisible();
  await expect(page.getByRole('img', {name: /QR code/})).toBeVisible();
  if (caption) {
    await evidence(page, 'CB-102', caption);
  }
  await page.getByText("Can't scan? Type the setup key instead").click();
  const key = (await page.locator('code.key').textContent())!.replace(
    /\s/g,
    '',
  );
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel(/code/i).last().fill(codeFor(key));
  await page.getByRole('button', {name: button}).click();
  return key;
}

/**
 * The administrator's Users screen, filtered to one user.
 * @param browser the browser
 * @param user the user
 * @return the administrator's page and the user's row
 */
async function usersScreen(
  browser: Browser,
  user: NewUser,
): Promise<{page: Page; row: Locator}> {
  const page = await signedInPage(browser, ADMIN.email, '/admin/users');
  await page.getByLabel('Search users').fill(user.email);
  return {page, row: page.locator('tbody tr', {hasText: user.email})};
}

test.describe('authenticator setup with a one-time setup code', tag, () => {
  test('a new user sets up the authenticator while accepting the invitation, then signs in with both', async ({
    page,
    playwright,
  }) => {
    const api = await admin(playwright);
    const {offices} = await (
      await api.api.get('/api/offices', {headers: api.headers})
    ).json();
    const wdh = offices.find((o: {code: string}) => o.code === 'WDH');
    const email = `e2e.invitee.${unique()}@deeds.gov.na`;
    const invited = await api.api.post('/api/users', {
      headers: api.headers,
      data: {
        name: `E2E invitee ${unique()}`,
        email,
        officeId: wdh.id,
        roles: ['rev'],
      },
    });
    expect(invited.status(), await invited.text()).toBe(201);
    await api.dispose();

    await page.goto(appPath(await inviteLink(email)));
    await expect(
      page.getByRole('heading', {name: 'Activate your account'}),
    ).toBeVisible();
    await page.getByLabel('New password').fill(NEW_USER_PASSWORD);
    await page.getByLabel('Repeat password').fill(NEW_USER_PASSWORD);
    await page.getByRole('button', {name: 'Continue'}).click();
    const secret = await setUpAuthenticator(
      page,
      'Activate account',
      'Invitation, step 2: the new user sets up the authenticator app',
    );
    await expect(
      page.getByRole('heading', {name: 'Your account is ready'}),
    ).toBeVisible();
    await evidence(
      page,
      'CB-102',
      'Invitation: "Your account is ready" after the password and the authenticator',
    );
    await page.getByRole('button', {name: 'Go to sign-in'}).click();

    await enterPassword(page, email);
    // the activation's code is used up (CB-104)
    await page.getByLabel('6-digit code').fill(await freshCodeFor(secret));
    await page.getByRole('button', {name: 'Verify and sign in'}).click();
    await expect(page.locator('aside.sidebar')).toBeVisible();
  });

  test('"Reset 2FA" asks for confirmation, and Cancel changes nothing', async ({
    browser,
    playwright,
  }) => {
    const api = await admin(playwright);
    const user = await createUser(api, ['rev'], 'reset-cancel');
    await api.dispose();
    const {row, page} = await usersScreen(browser, user);
    await expect(row).toContainText('set up');
    await row.getByRole('button', {name: 'Reset 2FA'}).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(`Reset 2FA for ${user.name}?`);
    await expect(confirm).toContainText('signed out everywhere');
    await evidence(
      page,
      'CB-102',
      'Users: "Reset 2FA" asks for confirmation first',
    );
    await confirm.getByRole('button', {name: 'Cancel'}).click();
    await expect(confirm).toHaveCount(0);
    await expect(row.getByRole('button', {name: 'Reset 2FA'})).toBeVisible();
    await expect(row).not.toContainText('not set up');
  });

  test('"Reset 2FA" shows a one-time setup code with a copy button, once; the user is then "not set up"', async ({
    browser,
    playwright,
  }) => {
    const api = await admin(playwright);
    const user = await createUser(api, ['rev'], 'reset');
    await api.dispose();
    const {row, page} = await usersScreen(browser, user);
    await row.getByRole('button', {name: 'Reset 2FA'}).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', {name: 'Reset and show setup code'})
      .click();

    const dialog = page.getByRole('dialog', {
      name: `Setup code for ${user.name}`,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(SETUP_CODE)).toBeVisible();
    await expect(dialog.getByRole('button', {name: /copy/i})).toBeVisible();
    await expect(dialog).toContainText('Shown only once');
    await expect(dialog).toContainText('72 hours');
    await evidence(
      page,
      'CB-102',
      'The one-time setup code, shown once, with a copy button',
    );
    await dialog.getByRole('button', {name: 'Done'}).click();
    await expect(dialog).toHaveCount(0);

    await expect(row).toContainText('not set up');
    await expect(
      row.getByRole('button', {name: 'Give setup code'}),
    ).toBeVisible();
    await evidence(
      page,
      'CB-102',
      'Users: the 2FA column says "not set up", with "Give setup code"',
    );
    // shown once: the code is nowhere on the screen any more
    await expect(page.getByText(SETUP_CODE)).toHaveCount(0);
  });

  test('"Give setup code" shows a new code, and the earlier code no longer works', async ({
    browser,
    page,
    playwright,
  }) => {
    const api = await admin(playwright);
    const user = await createUser(api, ['rev'], 'give');
    const earlier = await resetTwoFactor(api, user);
    await api.dispose();

    const screen = await usersScreen(browser, user);
    await screen.row.getByRole('button', {name: 'Give setup code'}).click();
    const dialog = screen.page.getByRole('dialog', {
      name: `Setup code for ${user.name}`,
    });
    const shown = (await dialog.getByText(SETUP_CODE).textContent())!.trim();
    expect(shown).not.toBe(earlier);
    await dialog.getByRole('button', {name: 'Done'}).click();

    await enterPassword(page, user.email);
    await enterSetupCode(page, earlier);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('heading', {name: 'Enter your setup code'}),
    ).toBeVisible();
    await enterSetupCode(page, shown);
    await setUpAuthenticator(page, 'Verify and sign in');
    await expect(page.locator('aside.sidebar')).toBeVisible();
  });

  test('after a reset, sign-in asks for the setup code, then sets up the authenticator and signs in', async ({
    page,
    playwright,
  }) => {
    const api = await admin(playwright);
    const user = await createUser(api, ['rev'], 'signin');
    const setupCode = await resetTwoFactor(api, user);
    await api.dispose();

    await enterPassword(page, user.email);
    await expect(
      page.getByRole('heading', {name: 'Enter your setup code'}),
    ).toBeVisible();
    await expect(
      page.getByText('No code? Ask your administrator for one.'),
    ).toBeVisible();
    await evidence(
      page,
      'CB-102',
      'Sign-in: after the password, "Enter your setup code" (no QR code yet)',
    );
    // the password alone never shows a QR code or a setup key
    await expect(page.getByRole('img', {name: /QR code/})).toHaveCount(0);
    await expect(page.locator('code.key')).toHaveCount(0);

    await enterSetupCode(page, setupCode);
    const secret = await setUpAuthenticator(
      page,
      'Verify and sign in',
      'Sign-in: with the setup code accepted, the authenticator set-up',
    );
    await expect(page.locator('aside.sidebar')).toBeVisible();
    expect(secret).not.toBe(secretOf(user.email));
  });

  test('a wrong setup code is refused and the screen stays on the setup-code step', async ({
    page,
    playwright,
  }) => {
    const api = await admin(playwright);
    const user = await createUser(api, ['rev'], 'wrong');
    const setupCode = await resetTwoFactor(api, user);
    await api.dispose();

    await enterPassword(page, user.email);
    await enterSetupCode(
      page,
      setupCode === 'ABCD-EFGH' ? 'WXYZ-2345' : 'ABCD-EFGH',
    );
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('heading', {name: 'Enter your setup code'}),
    ).toBeVisible();
    await expect(page.getByRole('img', {name: /QR code/})).toHaveCount(0);
  });

  test("a reset sends the user's open session back to sign-in", async ({
    browser,
    playwright,
  }) => {
    const api = await admin(playwright);
    const user = await createUser(api, ['rev'], 'session');
    const page = await signedInPage(
      browser,
      user.email,
      '/',
      NEW_USER_PASSWORD,
    );
    await resetTwoFactor(api, user);
    await api.dispose();

    await page.reload();
    await expect(page).toHaveURL(/#\/login/);
    await expect(page.locator('aside.sidebar')).toHaveCount(0);
  });
});

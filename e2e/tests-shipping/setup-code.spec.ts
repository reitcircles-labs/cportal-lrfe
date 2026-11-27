/**
 * Setting up the authenticator only with a second proof (CB-102), in the shipping app: the
 * organisation page's staff list has the "Reset 2FA" and "Give setup code" actions (the shipping
 * app has no user list), and the shared sign-in screen asks a user without an authenticator for
 * the setup code before the QR code. Setup codes are read from the administrator's API answers
 * ({ setupCode }), never from a mailbox. Each test uses a clerk of its own organisation.
 */
import {
  expect,
  test,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import {codeFor} from '../support/auth';
import {
  INVITED_PASSWORD,
  demoEmails,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
  type SignedIn,
} from '../support/shipping';
import {evidence} from '../support/evidence';
import {DEMO_PASSWORD, GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

test.use({baseURL: SHIPPING_URL});

/** A setup code as the administrator sees it. */
const SETUP_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/**
 * A new organisation with its clerk, and the administrator's API session.
 * @param playwright the Playwright fixture
 * @param label a word for the names
 * @return the organisation, the administrator and a function that resets the clerk's 2FA
 */
async function clerkOfOwnOrganisation(
  playwright: PlaywrightWorkerArgs['playwright'],
  label: string,
): Promise<{
  organisation: Organisation;
  admin: SignedIn;
  resetClerk: () => Promise<string>;
}> {
  const api = await playwright.request.newContext({baseURL: GATEWAY_URL});
  const admin = await signIn(api, demoEmails('adm')[0]);
  const organisation = await organisationWithClerk(api, admin, label);
  const resetClerk = async () => {
    const res = await api.post(
      `/api/users/${organisation.clerk.id}/mfa-reset`,
      {headers: admin.headers},
    );
    expect(res.status(), await res.text()).toBe(200);
    const {setupCode} = await res.json();
    expect(setupCode).toMatch(SETUP_CODE);
    return setupCode;
  };
  return {organisation, admin, resetClerk};
}

/**
 * The password step on the shared sign-in screen.
 * @param page the page, on the shipping app
 * @param email the user's email
 */
async function enterPassword(page: Page, email: string): Promise<void> {
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(INVITED_PASSWORD);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
}

test.describe(
  'authenticator setup with a one-time setup code',
  {tag: '@CB-102'},
  () => {
    test("the organisation page's staff list resets 2FA with confirmation and shows the one-time code", async ({
      page,
      playwright,
    }) => {
      const {organisation, admin} = await clerkOfOwnOrganisation(
        playwright,
        'Reset',
      );
      await signInOnScreen(page, admin.email, DEMO_PASSWORD);
      await page.goto(`/#/admin/organisations/${organisation.id}`);
      const staff = page.getByRole('table', {name: 'Staff'});
      const row = staff.locator('tbody tr', {
        hasText: organisation.clerk.email,
      });
      await expect(row).toContainText('set up');
      await expect(row.getByRole('button', {name: 'Reset 2FA'})).toBeVisible();
      await evidence(
        page,
        'CB-102',
        'Organisation page: the staff list shows 2FA "set up", with "Reset 2FA"',
      );
      await row.getByRole('button', {name: 'Reset 2FA'}).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText(
        `Reset 2FA for ${organisation.clerk.name}?`,
      );
      await confirm
        .getByRole('button', {name: 'Reset and show setup code'})
        .click();

      const dialog = page.getByRole('dialog', {
        name: `Setup code for ${organisation.clerk.name}`,
      });
      await expect(dialog.getByText(SETUP_CODE)).toBeVisible();
      await expect(dialog.getByRole('button', {name: /copy/i})).toBeVisible();
      await expect(dialog).toContainText('Shown only once');
      await dialog.getByRole('button', {name: 'Done'}).click();

      await expect(row).toContainText('not set up');
      await expect(
        row.getByRole('button', {name: 'Give setup code'}),
      ).toBeVisible();
      await expect(page.getByText(SETUP_CODE)).toHaveCount(0);
      await evidence(
        page,
        'CB-102',
        'Organisation page: after the reset, 2FA "not set up", with "Give setup code"',
      );
    });

    test('a clerk signs in with the setup code, sets up the authenticator and is signed in', async ({
      page,
      playwright,
    }) => {
      const {organisation, resetClerk} = await clerkOfOwnOrganisation(
        playwright,
        'Setup',
      );
      const setupCode = await resetClerk();

      await enterPassword(page, organisation.clerk.email);
      await expect(
        page.getByRole('heading', {name: 'Enter your setup code'}),
      ).toBeVisible();
      // the password alone never shows a QR code
      await expect(page.getByRole('img', {name: /QR code/})).toHaveCount(0);
      await page.getByLabel('Setup code').fill(setupCode);
      await page.getByRole('button', {name: 'Continue'}).click();

      await expect(
        page.getByRole('heading', {name: 'Set up your authenticator'}),
      ).toBeVisible();
      await page.getByText("Can't scan? Type the setup key instead").click();
      const key = (await page.locator('code.key').textContent())!.replace(
        /\s/g,
        '',
      );
      await page.getByLabel('6-digit code').fill(codeFor(key));
      await page.getByRole('button', {name: 'Verify and sign in'}).click();
      await expect(page.getByRole('button', {name: 'Sign out'})).toBeVisible();
    });

    test('a setup code that was replaced by a new one is refused', async ({
      page,
      playwright,
    }) => {
      const {organisation, resetClerk} = await clerkOfOwnOrganisation(
        playwright,
        'Replaced',
      );
      const earlier = await resetClerk();
      const later = await resetClerk();
      expect(later).not.toBe(earlier);

      await enterPassword(page, organisation.clerk.email);
      await page.getByLabel('Setup code').fill(earlier);
      await page.getByRole('button', {name: 'Continue'}).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(
        page.getByRole('heading', {name: 'Enter your setup code'}),
      ).toBeVisible();
    });
  },
);

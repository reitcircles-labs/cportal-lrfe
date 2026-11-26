/**
 * Wrong authenticator codes (CB-101), in the shipping app: a typo or two still signs in as before;
 * five wrong codes end that sign-in, and signing in again works. The per-user lockout and the
 * gateway's limits per address are covered by the identity and gateway unit tests. Each test uses
 * a clerk of its own, so the shared demo users' count of wrong codes is never touched.
 */
import {
  expect,
  test,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import {codeFor, readSecrets, wrongCodeFor} from '../support/auth';
import {
  INVITED_PASSWORD,
  demoEmails,
  organisationWithClerk,
  signIn,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

test.use({baseURL: SHIPPING_URL});

/**
 * A clerk of a new organisation, invited, activated and enrolled through the API.
 * @param playwright the Playwright fixture
 * @return the clerk's email and authenticator secret
 */
async function freshClerk(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<{email: string; secret: string}> {
  const api = await playwright.request.newContext({baseURL: GATEWAY_URL});
  const admin = await signIn(api, demoEmails('adm')[0]);
  const organisation = await organisationWithClerk(api, admin, 'Codes');
  await api.dispose();
  const email = organisation.clerk.email;
  return {email, secret: readSecrets()[email]};
}

/**
 * The password step on the sign-in screen.
 * @param page the page, on the shipping app
 * @param email the user's email
 */
async function enterPassword(page: Page, email: string): Promise<void> {
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(INVITED_PASSWORD);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
}

/**
 * One code on the code step.
 * @param page the page, on the shipping app
 * @param code the 6-digit code
 */
async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', {name: 'Verify and sign in'}).click();
}

test.describe('wrong authenticator codes', {tag: '@CB-101'}, () => {
  test('a wrong code once or twice, then the right one, signs in as before', async ({
    page,
    playwright,
  }) => {
    const {email, secret} = await freshClerk(playwright);
    await enterPassword(page, email);
    for (let i = 0; i < 2; i++) {
      await enterCode(page, wrongCodeFor(secret));
      // The screen empties the field once the server has answered; the alert may still be the last one.
      await expect(page.getByLabel('6-digit code')).toHaveValue('');
      await expect(page.getByRole('alert')).toHaveText(
        'Invalid authenticator code',
      );
    }
    await enterCode(page, codeFor(secret));
    await expect(page.getByRole('button', {name: 'Sign out'})).toBeVisible();
  });

  test('after five wrong codes this sign-in is refused, and signing in again works', async ({
    page,
    playwright,
  }) => {
    const {email, secret} = await freshClerk(playwright);
    await enterPassword(page, email);
    for (let i = 0; i < 5; i++) {
      await enterCode(page, wrongCodeFor(secret));
      // The screen empties the field once the server has answered; the alert may still be the last one.
      await expect(page.getByLabel('6-digit code')).toHaveValue('');
      await expect(page.getByRole('alert')).toHaveText(
        'Invalid authenticator code',
      );
    }
    await enterCode(page, codeFor(secret));
    await expect(page.getByRole('alert')).toHaveText(
      'Too many wrong codes: sign in again',
    );
    await expect(page.getByRole('button', {name: 'Sign out'})).toHaveCount(0);

    await page.getByRole('button', {name: 'Use a different account'}).click();
    await enterPassword(page, email);
    await enterCode(page, codeFor(secret));
    await expect(page.getByRole('button', {name: 'Sign out'})).toBeVisible();
  });
});

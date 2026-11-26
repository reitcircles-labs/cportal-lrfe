/**
 * Maximum session age (CB-100), in the shipping app: an active signed-in user keeps working as
 * before, each reload renewing the session. The maximum age (12 hours by default) cannot be reached
 * in a real-time run; a session older than it is refused by the identity service's unit tests.
 */
import {expect, test} from '@playwright/test';
import {demoEmails, signIn, signInOnScreen} from '../support/shipping';
import {DEMO_PASSWORD, GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

test.use({baseURL: SHIPPING_URL});

test(
  'an active user keeps working: each reload renews the session as before',
  {tag: '@CB-100'},
  async ({page, playwright}) => {
    const email = demoEmails('adm')[0];
    // through the API first: it enrols the authenticator when this run has not done so yet
    const api = await playwright.request.newContext({baseURL: GATEWAY_URL});
    await signIn(api, email);
    await api.dispose();

    await signInOnScreen(page, email, DEMO_PASSWORD);
    const signOut = page.getByRole('button', {name: 'Sign out'});
    await expect(signOut).toBeVisible();

    for (let i = 0; i < 3; i++) {
      const renewed = page.waitForResponse(r =>
        r.url().endsWith('/api/auth/refresh'),
      );
      await page.reload();
      expect((await renewed).status()).toBe(200);
      await expect(page).not.toHaveURL(/#\/login/);
      await expect(signOut).toBeVisible();
    }
  },
);

/**
 * The shipping app (CB-2): it runs beside the land registry on the same backend, signs in with
 * the platform's sign-in screen and shows its empty home page. Not in the docker run
 * (npm run test:docker), which has no shipping container yet.
 */
import {expect, test} from '@playwright/test';
import {userByRole} from '../support/catalogue';
import {codeFor, secretOf} from '../support/auth';
import {DEMO_PASSWORD, SHIPPING_URL} from '../stack/config.mjs';

test.skip(!!process.env.E2E_DOCKER, 'no shipping container in the docker run');
test.use({baseURL: SHIPPING_URL});

test('the shipping app signs in with the shared sign-in screen and shows its home page', async ({
  page,
}) => {
  const user = userByRole('rec');
  await page.goto('/#/login');
  await expect(page.getByText('Electronic bills of lading')).toBeVisible();
  // the land registry's texts and its proof check page are not part of this app
  await expect(page.getByText('National land records programme')).toHaveCount(
    0,
  );
  await expect(page.getByRole('link', {name: 'Check it yourself'})).toHaveCount(
    0,
  );
  await test.info().attach('shipping sign-in', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByLabel('6-digit code').fill(codeFor(secretOf(user.email)));
  await page.getByRole('button', {name: 'Verify and sign in'}).click();

  await expect(page.getByText(`Signed in as ${user.name}`)).toBeVisible();
  await expect(page).toHaveTitle('Shipping Registry · Bills of lading');
  await test.info().attach('shipping home', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.getByRole('button', {name: 'Sign out'}).click();
  await expect(page).toHaveURL(/#\/login/);
});

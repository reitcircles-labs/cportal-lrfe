/**
 * The shipping app (CB-2): it runs beside the land registry on the same backend, signs in with
 * the platform's sign-in screen and shows its empty home page; its sign-in shows the port picture
 * (CB-6), the land registry's does not. Not in the docker run (npm run test:docker), which has no
 * shipping container yet.
 */
import {expect, test} from '@playwright/test';
import {userByRole} from '../support/catalogue';
import {codeFor, secretOf} from '../support/auth';
import {DEMO_PASSWORD, SHIPPING_URL, WEB_URL} from '../stack/config.mjs';

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

test('the shipping sign-in shows the port picture on a wide screen and on a phone, in light and dark mode', async ({
  page,
}) => {
  const picture = page.locator('picture.picture img');
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/#/login');
  await expect(picture).toBeVisible();
  await expect(picture).toHaveJSProperty('complete', true);
  await expect(page.getByText('Logo', {exact: true})).toBeVisible();
  await expect(page.getByText('Transfer', {exact: true})).toBeVisible();
  await test.info().attach('shipping sign-in, wide, light', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.getByRole('button', {name: 'Toggle dark mode'}).click();
  // the page fades its colours over 0.2 s: wait for the heading's dark-mode colour
  await expect(page.getByRole('heading', {name: 'Sign in'})).toHaveCSS(
    'color',
    'rgb(230, 236, 243)',
  );
  await test.info().attach('shipping sign-in, wide, dark', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByRole('button', {name: 'Toggle dark mode'}).click();

  await page.setViewportSize({width: 390, height: 844});
  await expect(picture).toBeVisible();
  await expect
    .poll(() => picture.evaluate(img => (img as HTMLImageElement).currentSrc))
    .toContain('port-narrow.svg');
  await test.info().attach('shipping sign-in, phone', {
    body: await page.screenshot({fullPage: true}),
    contentType: 'image/png',
  });
});

test.describe('the land registry', () => {
  test.use({baseURL: WEB_URL});

  test('keeps its sign-in panel without a picture', async ({page}) => {
    await page.setViewportSize({width: 1440, height: 900});
    await page.goto('/#/login');
    await expect(
      page.getByText('National land records programme'),
    ).toBeVisible();
    await expect(page.locator('.arms')).toHaveText('Coat ofarms');
    await expect(page.locator('picture.picture')).toHaveCount(0);
    await test.info().attach('land registry sign-in', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});

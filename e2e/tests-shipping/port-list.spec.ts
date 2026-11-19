/**
 * The port list (CB-63): the B/L form offers the UN/LOCODE sea ports as a port is typed, names the
 * port picked, and a port not on the list is refused, on the screen and by the API.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import {unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  demoEmails,
  TRADE_ROLE,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

const TICKET = 'CB-63';

/**
 * Types into a field of the form found by its label.
 * @param page the page
 * @param label the field's label
 * @param value what to type
 */
async function fill(page: Page, label: string, value: string): Promise<void> {
  await page.getByLabel(label, {exact: true}).fill(value);
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe('the port list of the B/L form (CB-63)', {tag: '@CB-63'}, () => {
  let api: APIRequestContext;
  let carrier: Organisation;
  let shipper: Organisation;

  test.beforeAll(async ({playwright}) => {
    test.setTimeout(180_000);
    api = await playwright.request.newContext({baseURL: GATEWAY_URL});
    const admin = await signIn(api, demoEmails('adm')[0]);
    carrier = await organisationWithClerk(api, admin, 'Carrier');
    shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('the record service searches the list by name and by code', async () => {
    const byName = await api.get('/api/records/ports?q=walvis', {
      headers: carrier.clerk.headers,
    });
    expect(byName.status(), await byName.text()).toBe(200);
    expect(
      (await byName.json()).items.map((port: {code: string}) => port.code),
    ).toContain('NAWVB');
    const byCode = await api.get('/api/records/ports?code=NLRTM', {
      headers: carrier.clerk.headers,
    });
    expect((await byCode.json()).items).toEqual([
      {code: 'NLRTM', name: 'Rotterdam', country: 'NL'},
    ]);
  });

  test('the form offers ports as one is typed and refuses one not on the list', async ({
    page,
  }) => {
    await page.setViewportSize({width: 1440, height: 1200});
    await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
    await page.getByRole('link', {name: 'New B/L'}).click();
    await expect(page.getByRole('heading', {name: 'New B/L'})).toBeVisible();

    // typing part of a name offers the matching ports
    await fill(page, 'Port of discharge', 'rotter');
    await expect(
      page.locator('#bl-portOfDischarge-ports option[value="NLRTM"]'),
    ).toHaveCount(1);
    await fill(page, 'Port of discharge', 'NLRTM');
    await expect(page.getByTestId('bl-portOfDischarge-name')).toHaveText(
      'Rotterdam, Netherlands',
    );
    await page
      .getByLabel('Port of discharge', {exact: true})
      .scrollIntoViewIfNeeded();
    await evidence(
      page,
      TICKET,
      'The port of discharge is picked from the list',
    );

    // a whole B/L with a port of loading that is not on the list
    const reference = `CB63${unique().toUpperCase()}`.slice(0, 20);
    await fill(page, 'B/L number', reference);
    await page.getByLabel('Carrier code', {exact: true}).selectOption('MSC');
    await fill(page, 'Booking reference', 'BKG-630001');
    await page.getByLabel('Shipper', {exact: true}).selectOption({
      label: shipper.name,
    });
    await fill(page, 'Street', 'Harbour Road 4');
    await fill(page, 'City', 'Port Town');
    await fill(page, 'Country code', 'NA');
    await fill(page, 'Vessel', 'Atlantic Crest');
    await fill(page, 'Voyage', '2611N');
    await fill(page, 'Port of loading', 'XXAAA');
    await fill(page, 'Planned departure', '2026-11-20');
    await fill(page, 'Planned arrival', '2026-12-08');
    await fill(page, 'Container number', 'MSKU7045123');
    await fill(page, 'Seal number', 'SL220871');
    await fill(page, 'Goods', '640 bags of green coffee');
    await fill(page, 'HS code', '090111');
    await fill(page, 'Number of packages', '640');
    await fill(page, 'Kind of packages', 'Bags');
    await fill(page, 'Gross weight (kg)', '38040');
    await page.getByRole('button', {name: 'Save draft'}).click();
    await expect(
      page.getByText('XXAAA is not a sea port').first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', {name: 'New B/L'})).toBeVisible();
    await evidence(page, TICKET, 'A port not on the list is refused');

    // picked from the list, the B/L is saved
    await fill(page, 'Port of loading', 'NAWVB');
    await page.getByRole('button', {name: 'Save draft'}).click();
    await expect(page).toHaveURL(/#\/bls\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('heading', {name: `B/L ${reference} (MSC)`}),
    ).toBeVisible();
  });
});

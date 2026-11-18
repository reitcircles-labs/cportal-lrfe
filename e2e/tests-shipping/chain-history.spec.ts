/**
 * The full chain of title (CB-53): a party opens "Full history and checks" from the B/L's page and
 * sees every step, the exceptions marked, each step's signature checked in the browser and how it
 * stands on the blockchain.
 */
import {expect, test, type APIRequestContext} from '@playwright/test';
import {unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  committedBl,
  demoEmails,
  negotiableBl,
  TRADE_ROLE,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

const TICKET = 'CB-53';

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe('the full chain of title (CB-53)', {tag: '@CB-53'}, () => {
  let api: APIRequestContext;
  let buyer: Organisation;
  let bl = {id: '', label: ''};

  test.beforeAll(async ({playwright}) => {
    test.setTimeout(240_000);
    api = await playwright.request.newContext({baseURL: GATEWAY_URL});
    const admin = await signIn(api, demoEmails('adm')[0]);
    const carrier = await organisationWithClerk(api, admin, 'Carrier');
    const shipper = await organisationWithClerk(
      api,
      admin,
      'Shipper',
      TRADE_ROLE,
    );
    buyer = await organisationWithClerk(api, admin, 'Buyer', TRADE_ROLE);
    const bank = await organisationWithClerk(api, admin, 'Bank', TRADE_ROLE);

    bl = await committedBl(api, carrier.clerk, admin, {
      document: negotiableBl(`CB53${unique().toUpperCase()}`.slice(0, 20)),
      partyOrganisations: {shipper: shipper.id},
      issue: true,
    });
    const steps: Array<[string, Record<string, string>, unknown]> = [
      [
        `/api/records/${bl.id}/title/endorse`,
        shipper.clerk.headers,
        {to: buyer.id, inBlank: true},
      ],
      [
        `/api/records/${bl.id}/title/transfer`,
        buyer.clerk.headers,
        {to: bank.id},
      ],
    ];
    for (const [url, headers, data] of steps) {
      const answer = await api.post(url, {headers, data});
      expect(answer.status(), `${url}: ${await answer.text()}`).toBe(200);
    }
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('a past holder sees every step, the exceptions marked, each checked', async ({
    page,
  }) => {
    await page.setViewportSize({width: 1440, height: 900});
    await signInOnScreen(page, buyer.clerk.email, INVITED_PASSWORD);
    await page.getByRole('link', {name: `Open ${bl.label}`}).click();
    await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();

    await page.getByRole('link', {name: 'Full history and checks'}).click();
    await expect(page).toHaveURL(new RegExp(`#/bls/${bl.id}/history$`));
    await expect(
      page.getByRole('heading', {name: `Chain of title: ${bl.label}`}),
    ).toBeVisible();
    await expect(page.getByRole('status').first()).toContainText(
      "All 3 steps carry the platform's signature, checked in your browser.",
    );
    const table = page.getByRole('table', {name: 'Full chain of title'});
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Issued');
    await expect(rows.nth(1)).toContainText('Exception');
    await expect(rows.nth(2)).toContainText('Transferred');
    await expect(rows.nth(2)).toContainText('Exception');
    await expect(table.locator('td.sig-checked')).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Linked to the latest step');
    await expect(rows.nth(2)).not.toContainText('Not proven');
    await evidence(
      page,
      TICKET,
      'Every step of the B/L, checked, exceptions marked',
    );

    await page.getByRole('link', {name: 'Back to the B/L'}).click();
    await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
  });
});

/**
 * Printable paper B/L PDF when switching an electronic B/L to paper (CB-86).
 *
 * A carrier issues a negotiable B/L to the shipper, who endorses it in blank to the buyer.
 * Before switching, no paper copy is offered and GET /api/records/:id/paper refuses 409.
 * After the buyer switches to paper, both the buyer and the carrier see the Paper B/L copy
 * box and can download the PDF (verified as a %PDF- document) or open it in a print tab;
 * an earlier past holder (the shipper) sees the closed state without the printable copy.
 */
import {readFileSync} from 'node:fs';
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
  TRADE_ROLE,
  committedBl,
  demoEmails,
  dismissToasts,
  negotiableBl,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

const TICKET = 'CB-86';

/**
 * Signs in on screen and opens a B/L from the home list.
 * @param page Playwright page
 * @param organisation organisation with clerk credentials
 * @param bl B/L summary
 * @param bl.label B/L label shown on the list link
 */
async function openBl(
  page: Page,
  organisation: Organisation,
  bl: {label: string},
): Promise<void> {
  await page.setViewportSize({width: 1440, height: 900});
  await signInOnScreen(page, organisation.clerk.email, INVITED_PASSWORD);
  await page.getByRole('link', {name: `Open ${bl.label}`}).click();
  await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'generating a printable paper B/L copy on switch to paper (CB-86)',
  {tag: '@CB-86'},
  () => {
    let api: APIRequestContext;
    let carrier: Organisation;
    let shipper: Organisation;
    let buyer: Organisation;
    let blRef: string;
    let bl: {id: string; label: string};

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(240_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      const admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
      buyer = await organisationWithClerk(api, admin, 'Buyer', TRADE_ROLE);
      blRef = `CB86${unique().toUpperCase()}`.slice(0, 20);
      bl = await committedBl(api, carrier.clerk, admin, {
        document: negotiableBl(blRef),
        partyOrganisations: {shipper: shipper.id},
        issue: true,
      });
      const endorsed = await api.post(`/api/records/${bl.id}/title/endorse`, {
        headers: shipper.clerk.headers,
        data: {to: buyer.id, inBlank: true},
      });
      expect(endorsed.status(), await endorsed.text()).toBe(200);
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('buyer switches to paper and downloads and prints the paper B/L PDF', async ({
      page,
    }) => {
      const before = await api.get(`/api/records/${bl.id}/paper`, {
        headers: buyer.clerk.headers,
      });
      expect(before.status()).toBe(409);

      await openBl(page, buyer, bl);
      await expect(
        page.getByRole('region', {name: 'Paper B/L copy'}),
      ).toHaveCount(0);

      await page.getByRole('button', {name: 'Switch to paper'}).click();
      const dialog = page.getByRole('alertdialog');
      await dialog
        .getByRole('button', {name: 'Switch to a bearer paper B/L'})
        .click();

      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Switched to paper',
      );
      await expect(
        page.getByRole('region', {name: 'Actions'}).getByRole('button'),
      ).toHaveCount(0);

      const paperBox = page.getByRole('region', {name: 'Paper B/L copy'});
      await expect(paperBox).toBeVisible();
      await expect(paperBox).toContainText('bearer document');
      await dismissToasts(page);
      await page.setViewportSize({width: 1440, height: 1200});
      await evidence(
        page,
        TICKET,
        'Buyer sees the Paper B/L copy download and print buttons after switching to paper',
      );
      await page.setViewportSize({width: 1440, height: 900});

      const downloadPromise = page.waitForEvent('download');
      await paperBox
        .getByRole('button', {name: 'Download paper B/L (PDF)'})
        .click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(`bl-${blRef}-v1-paper.pdf`);
      const savedPath = await download.path();
      if (!savedPath) {
        throw new Error('Expected downloaded PDF path to be present');
      }
      const bytes = readFileSync(savedPath);
      expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(bytes.length).toBeGreaterThan(1000);

      const popupPromise = page.waitForEvent('popup');
      const printResponsePromise = page.waitForResponse(
        res =>
          res.url().endsWith(`/api/records/${bl.id}/paper`) &&
          res.request().method() === 'GET',
      );
      await paperBox.getByRole('button', {name: 'Print paper B/L'}).click();
      const [popup, printResponse] = await Promise.all([
        popupPromise,
        printResponsePromise,
      ]);
      expect(printResponse.status()).toBe(200);
      expect(printResponse.headers()['content-type']).toContain(
        'application/pdf',
      );
      await popup.close();
    });

    test('carrier sees and can print the paper B/L copy', async ({page}) => {
      await openBl(page, carrier, bl);
      const paperBox = page.getByRole('region', {name: 'Paper B/L copy'});
      await expect(paperBox).toBeVisible();
      await dismissToasts(page);
      await page.setViewportSize({width: 1440, height: 1200});
      await evidence(
        page,
        TICKET,
        'Carrier also sees the Paper B/L copy download and print buttons on the switched B/L',
      );
      await page.setViewportSize({width: 1440, height: 900});

      const res = await api.get(`/api/records/${bl.id}/paper`, {
        headers: carrier.clerk.headers,
      });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('application/pdf');
    });

    test('earlier past holder does not see or download the paper B/L copy', async ({
      page,
    }) => {
      await openBl(page, shipper, bl);
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Switched to paper',
      );
      await expect(
        page.getByRole('region', {name: 'Paper B/L copy'}),
      ).toHaveCount(0);

      const res = await api.get(`/api/records/${bl.id}/paper`, {
        headers: shipper.clerk.headers,
      });
      expect(res.status()).toBe(403);
    });
  },
);

/**
 * SMDG carrier code dropdown and organisation default carrier code (CB-68, agreed design):
 * - Platform operator sets a carrier organisation's default SMDG carrier code on its admin page
 *   from the searchable SMDG Liner Code List.
 * - A new B/L opened by that carrier's clerk starts with that SMDG code selected.
 * - The create B/L form offers a searchable dropdown (code and name), accepts no free text, and
 *   still allows picking another SMDG code from the list.
 * - The record service refuses unlisted carrier codes on create and amend.
 * Screenshots with `npm run evidence -- CB-68 --spec tests-shipping/carrier-codes.spec.ts`.
 */
import {expect, test, type APIRequestContext} from '@playwright/test';
import {unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  TRADE_ROLE,
  demoEmails,
  dismissToasts,
  negotiableBl,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
  type SignedIn,
} from '../support/shipping';
import {DEMO_PASSWORD, GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

const TICKET = 'CB-68';

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'SMDG carrier code dropdown and default carrier code (CB-68)',
  {tag: '@CB-68'},
  () => {
    let api: APIRequestContext;
    let admin: SignedIn;
    let carrier: Organisation;
    let shipper: Organisation;

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(180_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('platform operator sets default SMDG carrier code on the organisation page', async ({
      page,
    }) => {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, admin.email, DEMO_PASSWORD);
      await page.getByRole('link', {name: `Open ${carrier.name}`}).click();
      await expect(
        page.getByRole('heading', {name: carrier.name, level: 1}),
      ).toBeVisible();

      const search = page.getByLabel('Search carrier codes', {exact: true});
      await search.fill('maersk');
      await expect(
        page.getByText(/^[1-9]\d* matching carriers?$/),
      ).toBeVisible();
      const select = page.getByLabel('Default carrier code', {exact: true});
      await expect(select.locator('option[value="MSK"]')).toHaveText(
        'MSK — Maersk',
      );
      await select.selectOption('MSK');
      await page.getByRole('button', {name: 'Save carrier code'}).click();
      await expect(page.getByText('SMDG MSK')).toBeVisible();
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'Platform operator sets default SMDG carrier code on organisation page',
      );
    });

    test('new B/L opens with the default carrier code selected and lets the clerk search and pick another SMDG code', async ({
      page,
    }) => {
      await page.setViewportSize({width: 1440, height: 950});
      await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
      await page.getByRole('link', {name: 'New B/L'}).click();
      await expect(page.getByRole('heading', {name: 'New B/L'})).toBeVisible();

      const select = page.getByLabel('Carrier code', {exact: true});
      await expect(select).toHaveValue('MSK');
      expect(await select.evaluate(el => el.tagName.toLowerCase())).toBe(
        'select',
      );
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'New B/L opens with the carrier default SMDG code selected',
      );

      // Search by carrier name and pick another SMDG code from the list
      await page
        .getByLabel('Search carrier codes', {exact: true})
        .fill('mediterranean');
      await expect(select.locator('option[value="MSC"]')).toHaveText(
        'MSC — Mediterranean Shipping Company',
      );
      await select.selectOption('MSC');
      await expect(select).toHaveValue('MSC');
      await evidence(
        page,
        TICKET,
        'Searchable SMDG carrier code dropdown showing code and carrier name',
      );

      const reference = `CB68${unique().toUpperCase()}`.slice(0, 20);
      await page.getByLabel('B/L number', {exact: true}).fill(reference);
      await page
        .getByLabel('Booking reference', {exact: true})
        .fill('BKG-680001');
      await page.getByLabel('Shipper', {exact: true}).selectOption({
        label: shipper.name,
      });
      await page.getByLabel('Street', {exact: true}).fill('Harbour Road 4');
      await page.getByLabel('City', {exact: true}).fill('Port Town');
      await page.getByLabel('Country code', {exact: true}).fill('NA');
      await page.getByLabel('Vessel', {exact: true}).fill('Atlantic Crest');
      await page.getByLabel('Voyage', {exact: true}).fill('2611N');
      await page.getByLabel('Port of loading', {exact: true}).fill('NAWVB');
      await page.getByLabel('Port of discharge', {exact: true}).fill('NLRTM');
      await page
        .getByLabel('Planned departure', {exact: true})
        .fill('2026-11-20');
      await page
        .getByLabel('Planned arrival', {exact: true})
        .fill('2026-12-08');
      await page
        .getByLabel('Container number', {exact: true})
        .fill('MSKU7045123');
      await page.getByLabel('Seal number', {exact: true}).fill('SL220871');
      await page
        .getByLabel('Goods', {exact: true})
        .fill('640 bags of green coffee');
      await page.getByLabel('HS code', {exact: true}).fill('090111');
      await page.getByLabel('Number of packages', {exact: true}).fill('640');
      await page.getByLabel('Kind of packages', {exact: true}).fill('Bags');
      await page.getByLabel('Gross weight (kg)', {exact: true}).fill('38040');

      await page.getByRole('button', {name: 'Save draft'}).click();
      await expect(page).toHaveURL(/#\/bls\/[0-9a-f-]{36}$/);
      await expect(
        page.getByRole('heading', {name: `B/L ${reference} (MSC)`}),
      ).toBeVisible();
    });

    test('record service refuses unlisted carrier codes on create and enforces permissions on /records/carriers', async () => {
      const badCreate = await api.post('/api/records', {
        headers: carrier.clerk.headers,
        data: {
          format: 'dcsa-3.0',
          document: {
            ...negotiableBl(`CB68BAD${unique().toUpperCase()}`.slice(0, 20)),
            carrierCode: 'BWML',
          },
          partyOrganisations: {shipper: shipper.id},
        },
      });
      expect(badCreate.status(), await badCreate.text()).toBe(400);
      expect((await badCreate.json()).details?.code).toBe(
        'unknown-carrier-code',
      );

      const tradeCarriers = await api.get('/api/records/carriers', {
        headers: shipper.clerk.headers,
      });
      expect(tradeCarriers.status()).toBe(403);
    });
  },
);

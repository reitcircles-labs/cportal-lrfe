/**
 * The end of a B/L's journey on the shipping app's screens (CB-46, good weather, from the CB-13
 * design): the buyer surrenders the B/L to the carrier and the carrier releases the goods. A
 * carrier issues a B/L to order to the shipper, who endorses it to the buyer (through the API, as
 * endorse.spec.ts does); the buyer's trade clerk surrenders it on the screen after a confirmation
 * of what happens, and the B/L shows Surrendered, held by the carrier; the carrier's clerk
 * releases the goods, and the B/L shows Accomplished: no holder, no further actions, the chain of
 * title complete. Every party's list shows the final state. Screenshots for the ticket with
 * `npm run evidence -- CB-46 --shipping` (support/evidence.ts).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
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
  serviceToken,
  signIn,
  signInOnScreen,
  type Organisation,
} from '../support/shipping';
import {GATEWAY_URL, REPO_DIR, SHIPPING_URL} from '../stack/config.mjs';

/** The ticket the screenshots are for. */
const TICKET = 'CB-46';

/** What the B/L box says once the B/L is surrendered. */
const SURRENDERED_NOTE =
  'Surrendered: the carrier holds the B/L to release the goods.';

/** What the B/L box says once the B/L is accomplished. */
const ACCOMPLISHED_NOTE =
  'Accomplished: the goods are released, nobody holds the B/L any more and its chain of title is complete.';

/**
 * DCSA's example transport document (a B/L to order) with its own reference.
 * @param reference the transport document reference
 * @return the document
 */
function negotiableBl(reference: string): Record<string, unknown> {
  const path = join(
    REPO_DIR,
    'backend',
    'domains',
    'shipping',
    'dcsa',
    '3.0.3',
    'examples',
    'td-regular.json',
  );
  const example = JSON.parse(readFileSync(path, 'utf8'));
  return {...example, transportDocumentReference: reference};
}

/**
 * Closes the toasts on the screen, so that a screenshot shows the page alone.
 * @param page the page
 */
async function dismissToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', {name: 'Dismiss'});
  while ((await dismiss.count()) > 0) {
    // a toast may close by itself between the count and the click
    await dismiss
      .first()
      .click({timeout: 2_000})
      .catch(() => undefined);
  }
  await expect(dismiss).toHaveCount(0);
}

/**
 * A screenshot of the whole page: the window made tall enough, then set back.
 * @param page the page
 * @param caption the screenshot's caption
 */
async function fullPageEvidence(page: Page, caption: string): Promise<void> {
  await page.setViewportSize({width: 1440, height: 1500});
  await evidence(page, TICKET, caption);
  await page.setViewportSize({width: 1440, height: 900});
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'surrendering a B/L and releasing its goods on the screens (CB-46)',
  {tag: '@CB-46'},
  () => {
    let api: APIRequestContext;
    let carrier: Organisation;
    let shipper: Organisation;
    let buyer: Organisation;
    let bl: {id: string; label: string};

    /**
     * Signs a clerk in on the screen and opens the B/L from the home list.
     * @param page the page
     * @param organisation the clerk's organisation
     */
    async function openBl(
      page: Page,
      organisation: Organisation,
    ): Promise<void> {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, organisation.clerk.email, INVITED_PASSWORD);
      await page.getByRole('link', {name: `Open ${bl.label}`}).click();
      await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
    }

    /**
     * Checks the B/L page shows it accomplished: no holder, nothing more to do, the chain
     * complete with its four steps, the release last.
     * @param page the page, on the B/L
     * @param role the organisation's role shown
     */
    async function expectAccomplished(page: Page, role: string): Promise<void> {
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Accomplished',
      );
      await expect(page.locator('dt:text-is("Holder") + dd')).toHaveText('—');
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        role,
      );
      await expect(
        page.getByRole('status').filter({hasText: ACCOMPLISHED_NOTE}),
      ).toHaveCount(1);
      await expect(
        page.getByRole('region', {name: 'Actions'}).getByRole('button'),
      ).toHaveCount(0);
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(4);
      await expect(chain.locator('tbody tr').nth(2)).toContainText(
        'Surrendered',
      );
      await expect(chain.locator('tbody tr').last()).toContainText('Released');
    }

    /**
     * Checks a user's home lists the B/L once, accomplished, with no holder and the role given.
     * @param page the page, signed in
     * @param role the role shown
     */
    async function expectAccomplishedOnHome(
      page: Page,
      role: string,
    ): Promise<void> {
      await page.goto('/#/');
      const table = page.getByRole('table', {name: 'Bills of lading'});
      const row = table.locator('tbody tr').filter({hasText: bl.label});
      await expect(row).toHaveCount(1);
      await expect(row.locator('td').nth(2)).toContainText('Accomplished');
      await expect(row.locator('td').nth(3)).toHaveText('—');
      await expect(row.locator('td').nth(4)).toHaveText(role);
    }

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(240_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      const admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
      buyer = await organisationWithClerk(api, admin, 'Buyer', TRADE_ROLE);

      const created = await api.post('/api/records', {
        headers: carrier.clerk.headers,
        data: {
          format: 'dcsa-3.0',
          document: negotiableBl(`CB46${unique().toUpperCase()}`.slice(0, 20)),
          partyOrganisations: {shipper: shipper.id},
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      const record = await created.json();
      bl = {id: record.id, label: record.label};
      const submitted = await api.post(
        `/api/records/${bl.id}/versions/1/submit`,
        {headers: carrier.clerk.headers},
      );
      expect(submitted.status(), await submitted.text()).toBe(200);
      // the second pair of eyes: a decision reported by bpm, by someone other than the submitter
      const committed = await api.post(
        `/api/records/${bl.id}/versions/1/commit`,
        {
          headers: {authorization: `Bearer ${serviceToken('bpm')}`},
          data: {by: {id: admin.id, name: admin.name}},
        },
      );
      expect(committed.status(), await committed.text()).toBe(200);
      const issued = await api.post(`/api/records/${bl.id}/title/issue`, {
        headers: carrier.clerk.headers,
        data: {},
      });
      expect(issued.status(), await issued.text()).toBe(200);
      const endorsed = await api.post(`/api/records/${bl.id}/title/endorse`, {
        headers: shipper.clerk.headers,
        data: {to: buyer.id, inBlank: false},
      });
      expect(endorsed.status(), await endorsed.text()).toBe(200);
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test("the buyer's trade clerk surrenders the B/L to the carrier", async ({
      page,
    }) => {
      await openBl(page, buyer);
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        'Holder',
      );
      const surrender = page.getByRole('button', {
        name: 'Surrender to the carrier',
      });
      await expect(surrender).toBeVisible();
      // the carrier's command is not the holder's
      await expect(
        page.getByRole('button', {name: 'Release the goods'}),
      ).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, TICKET, 'The buyer holds the B/L');

      await surrender.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(
        `Surrender ${bl.label} to the carrier?`,
      );
      await expect(dialog).toContainText(
        'The carrier will hold the B/L to release the goods; you can no longer endorse it.',
      );
      await evidence(page, TICKET, 'The buyer confirms the surrender');
      await dialog
        .getByRole('button', {name: 'Surrender', exact: true})
        .click();

      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Surrendered',
      );
      await expect(page.locator('dt:text-is("Holder") + dd')).toHaveText(
        carrier.name,
      );
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        'Past holder',
      );
      const note = page.getByRole('status').filter({hasText: SURRENDERED_NOTE});
      await expect(note).toHaveCount(1);
      // the button is gone: the focus moves to where the B/L stands
      await expect(note).toBeFocused();
      await expect(
        page.getByRole('region', {name: 'Actions'}).getByRole('button'),
      ).toHaveCount(0);
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(3);
      const last = chain.locator('tbody tr').last();
      await expect(last).toContainText('Surrendered');
      await expect(last).toContainText(buyer.name);
      await expect(last).toContainText(carrier.name);
      await dismissToasts(page);
      await fullPageEvidence(page, 'Surrendered: held by the carrier');
    });

    test('the carrier releases the goods: the B/L is accomplished', async ({
      page,
    }) => {
      await openBl(page, carrier);
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Surrendered',
      );
      const release = page.getByRole('button', {name: 'Release the goods'});
      await expect(release).toBeVisible();
      await dismissToasts(page);
      await evidence(page, TICKET, 'The carrier holds the surrendered B/L');

      await release.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Release the goods of ${bl.label}?`);
      await expect(dialog).toContainText(
        'The B/L becomes accomplished: nobody holds it any more and its chain of title is complete.',
      );
      await evidence(page, TICKET, 'The carrier confirms the release');
      await dialog.getByRole('button', {name: 'Release', exact: true}).click();

      await expectAccomplished(page, 'Carrier');
      await expect(
        page.getByRole('status').filter({hasText: ACCOMPLISHED_NOTE}),
      ).toBeFocused();
      await dismissToasts(page);
      await fullPageEvidence(page, "Accomplished: the carrier's page");
      await expectAccomplishedOnHome(page, 'Carrier');
      await dismissToasts(page);
      await evidence(page, TICKET, "The carrier's list: accomplished");
    });

    test('the B/L page shows it accomplished for the buyer too', async ({
      page,
    }) => {
      await openBl(page, buyer);
      await expectAccomplished(page, 'Past holder');
      await dismissToasts(page);
      await fullPageEvidence(page, "Accomplished: the buyer's page");
    });

    test("every past holder's list shows it accomplished", async ({page}) => {
      await page.setViewportSize({width: 1440, height: 900});
      const pastHolders: Array<[Organisation, string]> = [
        [shipper, "The shipper's list: accomplished"],
        [buyer, "The buyer's list: accomplished"],
      ];
      for (const [past, caption] of pastHolders) {
        await signInOnScreen(page, past.clerk.email, INVITED_PASSWORD);
        await expectAccomplishedOnHome(page, 'Past holder');
        await dismissToasts(page);
        await evidence(page, TICKET, caption);
        await page.getByRole('button', {name: 'Sign out'}).click();
      }
    });
  },
);

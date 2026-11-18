/**
 * Archiving a never-issued draft B/L (CB-71, agreed design):
 * - Any user who can draft B/Ls in the carrier's organisation sees "Archive" on a never-issued
 *   draft (draft or in review) and archives it after confirmation.
 * - The archived B/L leaves the B/L list (and number search), frees its carrier code and number
 *   for reuse, keeps its history, and rejects any further change or issue.
 * - Committed/issued B/Ls cannot be archived; other organisations never see the action.
 * Screenshots with `npm run evidence -- CB-71 --spec tests-shipping/archive-draft.spec.ts`.
 */
import {expect, test, type APIRequestContext} from '@playwright/test';
import {unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  committedBl,
  demoEmails,
  dismissToasts,
  negotiableBl,
  TRADE_ROLE,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
  type SignedIn,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

const TICKET = 'CB-71';

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'archiving a never-issued draft B/L on the screens (CB-71)',
  {tag: '@CB-71'},
  () => {
    let api: APIRequestContext;
    let admin: SignedIn;
    let carrier: Organisation;
    let shipper: Organisation;
    let draftId = '';
    let draftLabel = '';
    const reference = `CB71${unique().toUpperCase()}`.slice(0, 20);

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(180_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);

      const created = await api.post('/api/records', {
        headers: carrier.clerk.headers,
        data: {
          format: 'dcsa-3.0',
          document: negotiableBl(reference),
          partyOrganisations: {shipper: shipper.id},
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      const record = await created.json();
      draftId = record.id;
      draftLabel = record.label;
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('the carrier archives a never-issued draft after confirmation, removing it from the list and freeing its number', async ({
      page,
    }) => {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
      await page.getByRole('link', {name: `Open ${draftLabel}`}).click();
      await expect(page.getByRole('heading', {name: draftLabel})).toBeVisible();

      const archiveButton = page.getByRole('button', {name: 'Archive'});
      await expect(archiveButton).toBeVisible();
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'Carrier sees Archive on the draft B/L page',
      );

      await archiveButton.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Archive ${draftLabel}?`);
      await expect(dialog).toContainText('number will be free to use again');
      await evidence(
        page,
        TICKET,
        'Confirmation dialog before archiving the draft',
      );
      await dialog.getByRole('button', {name: 'Archive draft'}).click();

      await expect(page).toHaveURL(/#\/$/);
      const table = page.getByRole('table', {name: 'Bills of lading'});
      await expect(
        table.locator('tbody tr').filter({hasText: draftLabel}),
      ).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, TICKET, 'B/L list without the archived draft');

      // Direct visit shows Archived with no edit/submit/archive buttons
      await page.goto(`/#/bls/${draftId}`);
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Archived',
      );
      await expect(page.getByRole('link', {name: 'Edit'})).toHaveCount(0);
      await expect(
        page.getByRole('button', {name: 'Submit for approval'}),
      ).toHaveCount(0);
      await expect(page.getByRole('button', {name: 'Archive'})).toHaveCount(0);

      // The number is freed for a new draft with the same carrier code and reference
      const recreated = await api.post('/api/records', {
        headers: carrier.clerk.headers,
        data: {
          format: 'dcsa-3.0',
          document: negotiableBl(reference),
          partyOrganisations: {shipper: shipper.id},
        },
      });
      expect(recreated.status(), await recreated.text()).toBe(201);
    });

    test('issued B/Ls cannot be archived and other organisations never see the action', async ({
      page,
    }) => {
      const issued = await committedBl(api, carrier.clerk, admin, {
        document: negotiableBl(`CB71I${unique().toUpperCase()}`.slice(0, 20)),
        partyOrganisations: {shipper: shipper.id},
        issue: true,
      });

      const refuseCarrier = await api.post(
        `/api/records/${issued.id}/archive`,
        {
          headers: carrier.clerk.headers,
        },
      );
      expect(refuseCarrier.status(), await refuseCarrier.text()).toBe(409);

      const refuseShipper = await api.post(
        `/api/records/${issued.id}/archive`,
        {
          headers: shipper.clerk.headers,
        },
      );
      expect(refuseShipper.status(), await refuseShipper.text()).toBe(403);

      const otherCarrier = await organisationWithClerk(api, admin, 'Other');
      const refuseOther = await api.post(`/api/records/${issued.id}/archive`, {
        headers: otherCarrier.clerk.headers,
      });
      expect(refuseOther.status(), await refuseOther.text()).toBe(404);

      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, shipper.clerk.email, INVITED_PASSWORD);
      await page.getByRole('link', {name: `Open ${issued.label}`}).click();
      await expect(
        page.getByRole('heading', {name: issued.label}),
      ).toBeVisible();
      await expect(page.getByRole('button', {name: 'Archive'})).toHaveCount(0);
    });
  },
);

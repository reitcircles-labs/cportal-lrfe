/**
 * The two ways an electronic B/L is closed early, on the shipping app's screens (CB-51, first
 * version, from the CB-8/CB-14 blueprint). A carrier issues two B/Ls to order to the shipper
 * (through the API, as surrender-release.spec.ts does). The shipper endorses the first in blank
 * to the buyer, whose trade clerk switches it to paper after confirming that the paper is a
 * bearer document: the B/L shows "Switched to paper", no holder, no actions, the switch last in
 * its chain of title, and the shipper, an earlier holder, sees the same. The carrier's clerk
 * voids the second while the shipper still holds it: it shows "Void", and the shipper sees it.
 * Screenshots for the ticket with `npm run evidence -- CB-51 --spec
 * tests-shipping/switch-to-paper-void.spec.ts` (support/evidence.ts).
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
  committedBl,
  demoEmails,
  dismissToasts,
  negotiableBl,
  TRADE_ROLE,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

/** The ticket the screenshots are for. */
const TICKET = 'CB-51';

/** What the B/L box says once the B/L is switched to paper. */
const SWITCHED_NOTE =
  'Switched to paper: the electronic B/L is closed and the paper B/L takes over. Nothing more can be done with it here.';

/** What the B/L box says once the B/L is void. */
const VOID_NOTE =
  'Void: the carrier cancelled this B/L. Nothing more can be done with it.';

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

/**
 * Checks the B/L page shows it closed: the end state, no holder, the note, no actions, and the
 * closing command last in the chain of title.
 * @param page the page, on the B/L
 * @param state the end state shown
 * @param note the note on where the B/L stands
 * @param lastStep what the chain's last row says
 */
async function expectClosed(
  page: Page,
  state: string,
  note: string,
  lastStep: string,
): Promise<void> {
  await expect(page.locator('dt:text-is("State") + dd')).toHaveText(state);
  await expect(page.locator('dt:text-is("Holder") + dd')).toHaveText('—');
  await expect(page.getByRole('status').filter({hasText: note})).toHaveCount(1);
  await expect(
    page.getByRole('region', {name: 'Actions'}).getByRole('button'),
  ).toHaveCount(0);
  const chain = page.getByRole('table', {name: 'Chain of title'});
  await expect(chain.locator('tbody tr').last()).toContainText(lastStep);
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'switching a B/L to paper and voiding another on the screens (CB-51)',
  {tag: '@CB-51'},
  () => {
    let api: APIRequestContext;
    let carrier: Organisation;
    let shipper: Organisation;
    let buyer: Organisation;
    let paperBl: {id: string; label: string};
    let voidBl: {id: string; label: string};

    /**
     * Creates, approves and issues a B/L to order to the shipper, through the API.
     * @param admin the platform admin, the second pair of eyes
     * @param admin.id the admin's id
     * @param admin.name the admin's name
     * @return the B/L's id and label
     */
    async function issuedBl(admin: {
      id: string;
      name: string;
    }): Promise<{id: string; label: string}> {
      return committedBl(api, carrier.clerk, admin, {
        document: negotiableBl(`CB51${unique().toUpperCase()}`.slice(0, 20)),
        partyOrganisations: {shipper: shipper.id},
        issue: true,
      });
    }

    /**
     * Signs a clerk in on the screen and opens a B/L from the home list.
     * @param page the page
     * @param organisation the clerk's organisation
     * @param bl the B/L
     * @param bl.label its label
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

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(240_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      const admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
      buyer = await organisationWithClerk(api, admin, 'Buyer', TRADE_ROLE);
      paperBl = await issuedBl(admin);
      voidBl = await issuedBl(admin);
      const endorsed = await api.post(
        `/api/records/${paperBl.id}/title/endorse`,
        {
          headers: shipper.clerk.headers,
          data: {to: buyer.id, inBlank: true},
        },
      );
      expect(endorsed.status(), await endorsed.text()).toBe(200);
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('the buyer switches the blank-endorsed B/L to paper, confirming the bearer document', async ({
      page,
    }) => {
      await openBl(page, buyer, paperBl);
      const switchButton = page.getByRole('button', {name: 'Switch to paper'});
      await expect(switchButton).toBeVisible();
      // the void is the carrier's
      await expect(page.getByRole('button', {name: 'Void'})).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, TICKET, 'The buyer holds the blank-endorsed B/L');

      await switchButton.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Switch ${paperBl.label} to paper?`);
      await expect(dialog).toContainText('the paper B/L takes over');
      await expect(dialog).toContainText('bearer document');
      await evidence(page, TICKET, 'The buyer confirms the switch to paper');
      await dialog
        .getByRole('button', {name: 'Switch to a bearer paper B/L'})
        .click();

      await expectClosed(
        page,
        'Switched to paper',
        SWITCHED_NOTE,
        'Switched to paper',
      );
      await expect(
        page.getByRole('status').filter({hasText: SWITCHED_NOTE}),
      ).toBeFocused();
      await dismissToasts(page);
      await fullPageEvidence(page, "Switched to paper: the buyer's page");
    });

    test('the shipper, an earlier holder, sees it switched to paper', async ({
      page,
    }) => {
      await openBl(page, shipper, paperBl);
      await expectClosed(
        page,
        'Switched to paper',
        SWITCHED_NOTE,
        'Switched to paper',
      );
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        'Past holder',
      );
      await dismissToasts(page);
      await fullPageEvidence(page, "Switched to paper: the shipper's page");
    });

    test('the carrier voids the B/L the shipper still holds', async ({
      page,
    }) => {
      await openBl(page, carrier, voidBl);
      const voidButton = page.getByRole('button', {name: 'Void'});
      await expect(voidButton).toBeVisible();
      // the switch to paper is the holder's
      await expect(
        page.getByRole('button', {name: 'Switch to paper'}),
      ).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, TICKET, 'The carrier may void the issued B/L');

      await voidButton.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Void ${voidBl.label}?`);
      await expect(dialog).toContainText('cancelled for good');
      await evidence(page, TICKET, 'The carrier confirms the void');
      await dialog.getByRole('button', {name: 'Void the B/L'}).click();

      await expectClosed(page, 'Void', VOID_NOTE, 'Voided');
      await dismissToasts(page);
      await fullPageEvidence(page, "Void: the carrier's page");
    });

    test('the shipper sees the B/L void', async ({page}) => {
      await openBl(page, shipper, voidBl);
      await expectClosed(page, 'Void', VOID_NOTE, 'Voided');
      await dismissToasts(page);
      await fullPageEvidence(page, "Void: the shipper's page");
    });
  },
);

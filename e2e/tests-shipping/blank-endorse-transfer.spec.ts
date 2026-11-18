/**
 * Endorsing a B/L in blank and transferring it on, on the shipping app's screens (CB-52, first
 * version, from the CB-12 design and the title engine). A carrier issues a B/L to order to the
 * shipper (through the API, as switch-to-paper-void.spec.ts does). The shipper's trade clerk
 * endorses it in blank to bank A, after a confirmation that says what in blank means; bank A sees
 * it endorsed in blank and transfers it to bank B after a confirmation; bank B holds it, may
 * transfer it on, and its chain of title shows the blank endorsement and the transfer. The
 * shipper, a past holder, may no longer act on it. Screenshots for the ticket with
 * `npm run evidence -- CB-52 --spec tests-shipping/blank-endorse-transfer.spec.ts`
 * (support/evidence.ts).
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
const TICKET = 'CB-52';

/** What a blank endorsement means, as the confirmation and the panel say it. */
const BLANK_MEANING = 'no longer names a holder by endorsement';

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
 * Checks the B/L page shows the holder, the blank endorsement and the chain's last step.
 * @param page the page, on the B/L
 * @param holder what the holder line says
 * @param lastStep what the chain's last row says
 */
async function expectBlankEndorsed(
  page: Page,
  holder: string,
  lastStep: string,
): Promise<void> {
  await expect(page.locator('dt:text-is("Holder") + dd')).toHaveText(holder);
  await expect(page.locator('dt:text-is("Endorsement") + dd')).toHaveText(
    'Endorsed in blank',
  );
  const chain = page.getByRole('table', {name: 'Chain of title'});
  await expect(chain.locator('tbody tr').last()).toContainText(lastStep);
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'endorsing a B/L in blank and transferring it on the screens (CB-52)',
  {tag: '@CB-52'},
  () => {
    let api: APIRequestContext;
    let carrier: Organisation;
    let shipper: Organisation;
    let bankA: Organisation;
    let bankB: Organisation;
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

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(240_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      const admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
      bankA = await organisationWithClerk(api, admin, 'BankA', TRADE_ROLE);
      bankB = await organisationWithClerk(api, admin, 'BankB', TRADE_ROLE);
      bl = await committedBl(api, carrier.clerk, admin, {
        document: negotiableBl(`CB52${unique().toUpperCase()}`.slice(0, 20)),
        partyOrganisations: {shipper: shipper.id},
        issue: true,
      });
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('the shipper endorses the B/L in blank to bank A, confirming what it means', async ({
      page,
    }) => {
      await openBl(page, shipper);
      await expect(page.locator('dt:text-is("Endorsement") + dd')).toHaveText(
        'Not endorsed yet',
      );
      // a B/L not endorsed in blank is not transferred
      await expect(
        page.getByRole('button', {name: 'Transfer to…'}),
      ).toHaveCount(0);
      await page.getByRole('button', {name: 'Endorse to…'}).click();
      const panel = page.getByRole('region', {name: 'Endorse', exact: true});
      await panel
        .getByRole('radiogroup', {name: 'Endorse to'})
        .getByRole('radio', {name: bankA.name})
        .check();
      await panel.getByRole('radio', {name: /In blank/}).check();
      await expect(panel.getByRole('status')).toContainText(BLANK_MEANING);
      await dismissToasts(page);
      await evidence(page, TICKET, 'The shipper chooses to endorse in blank');

      await panel.getByRole('button', {name: 'Endorse', exact: true}).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(
        `Endorse ${bl.label} in blank and hand it to ${bankA.name}?`,
      );
      await expect(dialog).toContainText(BLANK_MEANING);
      await evidence(
        page,
        TICKET,
        'The shipper confirms the blank endorsement',
      );
      await dialog.getByRole('button', {name: 'Endorse in blank'}).click();

      await expectBlankEndorsed(page, bankA.name, 'Endorsed in blank');
      await expect(
        page.getByRole('region', {name: 'Actions'}).getByRole('button'),
      ).toHaveCount(0);
      await dismissToasts(page);
      await fullPageEvidence(page, "Endorsed in blank: the shipper's page");
    });

    test('bank A sees it endorsed in blank and transfers it to bank B', async ({
      page,
    }) => {
      await openBl(page, bankA);
      await expectBlankEndorsed(
        page,
        `${bankA.name} (your organisation)`,
        'Endorsed in blank',
      );
      const transfer = page.getByRole('button', {name: 'Transfer to…'});
      await expect(transfer).toBeVisible();
      await expect(
        page.getByRole('button', {name: 'Endorse to…'}),
      ).toBeVisible();
      await dismissToasts(page);
      await evidence(page, TICKET, 'Bank A holds the blank-endorsed B/L');

      await transfer.click();
      const panel = page.getByRole('region', {name: 'Transfer', exact: true});
      // a transfer has no choice of how: the B/L stays endorsed in blank
      await expect(panel.getByRole('radio', {name: /In blank/})).toHaveCount(0);
      await panel
        .getByRole('radiogroup', {name: 'Transfer to'})
        .getByRole('radio', {name: bankB.name})
        .check();
      await panel.getByRole('button', {name: 'Transfer', exact: true}).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(
        `Transfer ${bl.label} to ${bankB.name}?`,
      );
      await expect(dialog).toContainText(`${bankB.name} becomes the holder`);
      await evidence(page, TICKET, 'Bank A confirms the transfer to bank B');
      await dialog.getByRole('button', {name: 'Transfer', exact: true}).click();

      await expectBlankEndorsed(page, bankB.name, 'Transferred');
      await expect(
        page.getByRole('button', {name: 'Transfer to…'}),
      ).toHaveCount(0);
      await dismissToasts(page);
      await fullPageEvidence(page, "Transferred: bank A's page");
    });

    test('bank B holds it and may transfer it on', async ({page}) => {
      await openBl(page, bankB);
      await expectBlankEndorsed(
        page,
        `${bankB.name} (your organisation)`,
        'Transferred',
      );
      await expect(
        page.getByRole('button', {name: 'Transfer to…'}),
      ).toBeVisible();
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(3);
      await dismissToasts(page);
      await fullPageEvidence(page, 'Bank B holds the B/L: its chain of title');
    });
  },
);

/**
 * The amendment and the split of a B/L on the shipping app's screens (CB-50, first version, from
 * the CB-14 design). A carrier issues a B/L to order with two containers to the shipper, who
 * endorses it to the buyer (through the API, as surrender-release.spec.ts does). On the screens:
 * the buyer's trade clerk asks the carrier for a change; the carrier's clerk amends the port of
 * discharge (the change marked against version 1), and version 2 goes back to the buyer; the
 * shipper, an earlier holder, is told the B/L was amended after it held it, never the new values.
 * The buyer asks for a change again; the carrier splits the B/L into two, one container each: the
 * button waits until the cargo adds up, a number the carrier already uses is refused in the
 * panel, and then the parent is closed ("Replaced by" its children) and each child, "Split from"
 * the parent, is with the buyer. Screenshots with `npm run evidence -- CB-50 --shipping`.
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
  committedBl as createCommittedBl,
  demoEmails,
  dismissToasts,
  TRADE_ROLE,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
  type SignedIn,
} from '../support/shipping';
import {
  CONTAINER_A,
  CONTAINER_B,
  OTHER_PORT,
  PARENT_PORT,
  twoContainerBl,
} from '../../backend/services/shipping-records/tests/split-documents.js';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

/** The ticket the screenshots are for. */
const TICKET = 'CB-50';

/** What the holder's confirmation says happens. */
const ASK_BODY =
  'The carrier will hold the B/L to change it and give it back to you. You cannot endorse or surrender it until then.';

/**
 * The value of a fact of the B/L box.
 * @param page the page, on a B/L
 * @param label the fact's label
 * @return its locator
 */
function fact(page: Page, label: string) {
  return page.locator(`dt:text-is("${label}") + dd`);
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'amending a B/L and splitting it into new B/Ls on the screens (CB-50)',
  {tag: ['@CB-50', '@CB-85']},
  () => {
    let api: APIRequestContext;
    let admin: SignedIn;
    let carrier: Organisation;
    let shipper: Organisation;
    let buyer: Organisation;
    let bl: {id: string; label: string; recordNo: string};
    /** A number the carrier already uses: another B/L of its own. */
    let takenNumber: string;
    /** The numbers given to the two new B/Ls. */
    let childNumbers: string[];

    /**
     * Signs a clerk in on the screen and opens the B/L from the home list.
     * @param page the page
     * @param organisation the clerk's organisation
     */
    async function openBl(
      page: Page,
      organisation: Organisation,
    ): Promise<void> {
      await page.setViewportSize({width: 1440, height: 1100});
      await signInOnScreen(page, organisation.clerk.email, INVITED_PASSWORD);
      await page
        .getByRole('link', {name: `Open ${bl.label}`, exact: true})
        .click();
      await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
    }

    /**
     * Creates a B/L of the carrier with two containers and commits its version 1 (four eyes:
     * the decision reported by bpm, by the administrator).
     * @param reference its number
     * @return its record
     */
    async function committedBl(
      reference: string,
    ): Promise<{id: string; label: string; recordNo: string}> {
      return createCommittedBl(api, carrier.clerk, admin, {
        document: twoContainerBl(reference),
        partyOrganisations: {shipper: shipper.id},
      });
    }

    /**
     * The holder asks the carrier for a change on the screen, stating the reason (CB-85).
     * @param page the page, on the B/L as the buyer
     * @param reason what needs to change
     */
    async function askForChange(
      page: Page,
      reason = 'Change port of discharge to DEHAM',
      capture = false,
    ): Promise<void> {
      await page.getByRole('button', {name: 'Ask for a change'}).click();
      const panel = page.getByRole('region', {name: 'Ask for a change'});
      await expect(panel).toContainText(
        `Ask the carrier to change or split ${bl.label}?`,
      );
      await expect(panel).toContainText(ASK_BODY);
      await panel.getByRole('button', {name: 'Send to the carrier'}).click();
      await expect(
        panel.getByText(
          'Describe what needs to change before sending to the carrier.',
        ),
      ).toBeVisible();
      await panel.getByLabel('What needs to change?').fill(reason);
      if (capture) {
        await evidence(page, TICKET, 'The holder confirms the request');
        await evidence(
          page,
          'CB-85',
          'Holder writes change request reason before sending',
        );
      }
      await panel.getByRole('button', {name: 'Send to the carrier'}).click();
      await expect(fact(page, 'State')).toHaveText('Change requested');
      await expect(fact(page, 'Holder')).toHaveText(
        `${carrier.name}, to go back to ${buyer.name} (your organisation)`,
      );
      await expect(
        page.getByRole('status').filter({
          hasText:
            'Change requested: the carrier holds the B/L to change it and give it back to you.',
        }),
      ).toHaveCount(1);
      await expect(page.getByText(`Your request: ${reason}`)).toBeVisible();
      // nothing more to do for the buyer until the B/L comes back
      await expect(
        page.getByRole('region', {name: 'Actions'}).getByRole('button'),
      ).toHaveCount(0);
    }

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(240_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
      buyer = await organisationWithClerk(api, admin, 'Buyer', TRADE_ROLE);

      const id = unique().toUpperCase();
      bl = await committedBl(`CB50${id}`.slice(0, 16));
      takenNumber = `CB50T${id}`.slice(0, 16);
      await committedBl(takenNumber);
      childNumbers = [`${bl.recordNo}-A`, `${bl.recordNo}-B`];

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

    test("the buyer's trade clerk asks the carrier for a change", async ({
      page,
    }) => {
      await openBl(page, buyer);
      await expect(fact(page, 'Version')).toContainText('Version 1');
      // the carrier's commands are not the holder's
      await expect(page.getByRole('button', {name: 'Amend'})).toHaveCount(0);
      await expect(page.getByRole('button', {name: 'Split'})).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, TICKET, 'The buyer holds the B/L');
      await askForChange(page, 'Change port of discharge to DEHAM', true);
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr').last()).toContainText(
        'Surrendered for amendment',
      );
      await expect(fact(page, 'Your role')).toHaveText(
        'Asked for a change: the B/L comes back to you',
      );
      await dismissToasts(page);
      await evidence(page, TICKET, 'Change requested: held by the carrier');
    });

    test('the carrier amends the port of discharge: version 2 goes back to the buyer', async ({
      page,
    }) => {
      await openBl(page, carrier);
      await expect(
        page.getByRole('status').filter({
          hasText: `${buyer.name} asked for a change. The B/L goes back to them.`,
        }),
      ).toHaveCount(1);
      await expect(
        page.getByText('Requested change: Change port of discharge to DEHAM'),
      ).toBeVisible();
      await expect(page.getByRole('button', {name: 'Split'})).toBeVisible();
      await dismissToasts(page);
      await evidence(
        page,
        'CB-85',
        'Carrier sees requested change reason on the B/L page',
      );
      await page.getByRole('button', {name: 'Amend', exact: true}).click();

      const panel = page.getByRole('region', {name: 'Amend'});
      await expect(panel.getByRole('note')).toContainText(
        `Requested by ${buyer.name}: Change port of discharge to DEHAM`,
      );
      await page.setViewportSize({width: 1440, height: 1500});
      await evidence(
        page,
        'CB-85',
        'Carrier sees requested change reason inside Amend panel',
      );
      await page.setViewportSize({width: 1440, height: 900});
      await expect(panel.getByLabel('B/L number')).toHaveValue(bl.recordNo);
      await expect(panel.getByLabel('B/L number')).toBeDisabled();
      await expect(panel.getByLabel('Carrier code')).toBeDisabled();
      const send = panel.getByRole('button', {name: 'Amend and give back'});
      // nothing changed yet
      await expect(send).toBeDisabled();
      await panel.getByLabel('Port of discharge').fill(OTHER_PORT);
      const changes = panel.getByRole('list', {name: 'Changes'});
      await expect(changes.locator('del')).toHaveText(PARENT_PORT);
      await expect(changes.locator('ins')).toHaveText(OTHER_PORT);
      await expect(send).toBeEnabled();
      await dismissToasts(page);
      await evidence(page, TICKET, 'The carrier amends the port of discharge');

      await send.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Amend ${bl.recordNo}?`);
      await expect(dialog).toContainText(
        `Version 2 of ${bl.recordNo} goes to ${buyer.name}. Version 1 is kept as superseded.`,
      );
      await dialog.getByRole('button', {name: 'Amend', exact: true}).click();
      await expect(
        page.getByText(`B/L amended: version 2 is with ${buyer.name}`),
      ).toBeVisible();

      await expect(fact(page, 'State')).toHaveText('With holder');
      await expect(fact(page, 'Holder')).toHaveText(buyer.name);
      await expect(fact(page, 'Version')).toContainText('Version 2 since');
      await expect(page.getByRole('region', {name: 'Amend'})).toHaveCount(0);
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr').last()).toContainText(
        'Amended: version 2',
      );
      await dismissToasts(page);
      await evidence(page, TICKET, 'Amended: version 2 with the buyer');
    });

    test('the buyer holds version 2 and may act on it as before', async ({
      page,
    }) => {
      await openBl(page, buyer);
      await expect(fact(page, 'Holder')).toHaveText(
        `${buyer.name} (your organisation)`,
      );
      await expect(fact(page, 'Version')).toContainText('Version 2 since');
      await expect(page.getByRole('list', {name: 'Versions'})).toContainText(
        'Version 1',
      );
      await expect(
        page.getByRole('button', {name: 'Endorse to…'}),
      ).toBeVisible();
      await expect(
        page.getByRole('button', {name: 'Surrender to the carrier'}),
      ).toBeVisible();
      await expect(
        page.getByRole('button', {name: 'Ask for a change'}),
      ).toBeVisible();
    });

    test('the shipper, an earlier holder, is told it was amended, never the new values', async ({
      page,
    }) => {
      await openBl(page, shipper);
      await expect(fact(page, 'Your role')).toHaveText('Past holder');
      await expect(page.getByText('Amended after you held it')).toBeVisible();
      await expect(fact(page, 'Version')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(OTHER_PORT);
      await expect(page.locator('body')).not.toContainText(
        'Change port of discharge to DEHAM',
      );
      await dismissToasts(page);
      await evidence(page, TICKET, 'The shipper is told it was amended');
    });

    test('the buyer asks for a change again; the carrier splits the B/L into two, one container each', async ({
      page,
    }) => {
      await openBl(page, buyer);
      await askForChange(page, 'Split cargo equally into two B/Ls');
      await page.getByRole('button', {name: 'Sign out'}).click();

      await openBl(page, carrier);
      await page.getByRole('button', {name: 'Split', exact: true}).click();
      const panel = page.getByRole('region', {name: 'Split'});
      await expect(panel.getByRole('note')).toContainText(
        `Requested by ${buyer.name}: Split cargo equally into two B/Ls`,
      );
      const send = panel.getByRole('button', {name: 'Split into 2 B/Ls'});
      // B/L B carries nothing yet
      await expect(send).toBeDisabled();
      await expect(panel.getByRole('list', {name: 'Problems'})).toContainText(
        'B/L B carries no cargo.',
      );
      await panel.getByLabel(`B/L A packages of ${CONTAINER_B}`).fill('0');
      await panel.getByLabel(`B/L A weight of ${CONTAINER_B}`).fill('0');
      await panel.getByLabel(`B/L B packages of ${CONTAINER_B}`).fill('180');
      await panel.getByLabel(`B/L B weight of ${CONTAINER_B}`).fill('6000');
      // a running total that does not add up
      await expect(panel.getByRole('list', {name: 'Problems'})).toContainText(
        `${CONTAINER_B}: the parts hold 180 packages; the B/L holds 200.`,
      );
      await expect(send).toBeDisabled();
      await panel.getByLabel(`B/L B packages of ${CONTAINER_B}`).fill('200');
      await expect(panel.getByRole('list', {name: 'Problems'})).toHaveCount(0);
      await expect(send).toBeEnabled();

      // a number the carrier already uses: refused by the record service, shown in the panel
      await panel.getByLabel('Number of B/L B').fill(takenNumber);
      await send.click();
      let dialog = page.getByRole('alertdialog');
      await dialog.getByRole('button', {name: 'Split', exact: true}).click();
      await expect(panel.getByRole('alert')).toContainText(
        `The carrier already has a B/L with the reference ${takenNumber}`,
      );
      await expect(fact(page, 'State')).toHaveText('Change requested');

      await panel.getByLabel('Number of B/L B').fill(childNumbers[1]);
      await dismissToasts(page);
      await evidence(page, TICKET, 'The carrier assigns the containers');
      await send.click();
      dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Split ${bl.recordNo} into 2 B/Ls?`);
      await expect(dialog).toContainText(
        `${bl.recordNo} is closed and 2 new B/Ls are issued to ${buyer.name}, each with its own number.`,
      );
      await dialog.getByRole('button', {name: 'Split', exact: true}).click();
      await expect(page.getByText('B/L split into 2 new B/Ls')).toBeVisible();

      await expect(fact(page, 'State')).toHaveText('Split');
      await expect(
        page.getByRole('region', {name: 'Actions'}).getByRole('button'),
      ).toHaveCount(0);
      const replaced = fact(page, 'Replaced by');
      for (const number of childNumbers) {
        await expect(replaced.getByRole('link', {name: number})).toBeVisible();
      }
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr').last()).toContainText(
        `Split into ${childNumbers.join(', ')}`,
      );
      await dismissToasts(page);
      await evidence(page, TICKET, 'Split: the parent is replaced');
    });

    test('each child is with the buyer, split from the parent', async ({
      page,
    }) => {
      await openBl(page, buyer);
      await expect(fact(page, 'State')).toHaveText('Split');
      await fact(page, 'Replaced by')
        .getByRole('link', {name: childNumbers[1]})
        .click();
      await expect(
        page.getByRole('heading', {name: childNumbers[1]}),
      ).toBeVisible();
      await expect(
        fact(page, 'Split from').getByRole('link', {name: bl.recordNo}),
      ).toBeVisible();
      await expect(fact(page, 'Holder')).toHaveText(
        `${buyer.name} (your organisation)`,
      );
      await expect(fact(page, 'Version')).toContainText('Version 1');
      await expect(
        page.getByRole('button', {name: 'Endorse to…'}),
      ).toBeVisible();
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr').first()).toContainText(
        `Issued from split of ${bl.recordNo}`,
      );
      await dismissToasts(page);
      await evidence(page, TICKET, 'A child B/L with the buyer');
    });

    test('the shipper is told the B/L was split after it held it', async ({
      page,
    }) => {
      await openBl(page, shipper);
      await expect(
        page.getByText(
          `Split into ${childNumbers.join(', ')} after you held it`,
        ),
      ).toBeVisible();
      await dismissToasts(page);
      await evidence(page, TICKET, 'The shipper is told it was split');
    });

    test(
      'carrier sets the split count flexibly, shrinks dropping the last part, and splits into 3 once cargo adds up (CB-73)',
      {tag: '@CB-73'},
      async ({page}) => {
        const flex = await committedBl(
          `CB73${unique().toUpperCase()}`.slice(0, 16),
        );
        const issued = await api.post(`/api/records/${flex.id}/title/issue`, {
          headers: carrier.clerk.headers,
          data: {},
        });
        expect(issued.status()).toBe(200);
        const requested = await api.post(
          `/api/records/${flex.id}/title/surrender-for-amendment`,
          {headers: shipper.clerk.headers, data: {}},
        );
        expect(requested.status()).toBe(200);

        await page.setViewportSize({width: 1440, height: 1100});
        await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
        await page
          .getByRole('link', {name: `Open ${flex.label}`, exact: true})
          .click();
        await expect(
          page.getByRole('heading', {name: flex.label}),
        ).toBeVisible();
        await page.getByRole('button', {name: 'Split', exact: true}).click();

        const panel = page.getByRole('region', {name: 'Split'});
        const count = panel.getByLabel('Number of new B/Ls');
        await expect(count).toHaveValue('2');
        await expect(
          panel.getByRole('button', {name: 'Remove last B/L'}),
        ).toBeDisabled();

        // Raise output B/L count directly to 4, fill B/L D, then shrink to 3 (drops D and its entries)
        await count.fill('4');
        await count.press('Tab');
        await expect(panel.getByLabel('Number of B/L D')).toBeVisible();
        await panel.getByLabel(`B/L D packages of ${CONTAINER_B}`).fill('50');
        await expect(
          panel.getByRole('button', {name: 'Split into 4 B/Ls'}),
        ).toBeVisible();

        await count.fill('3');
        await count.press('Tab');
        await expect(panel.getByLabel('Number of B/L D')).toHaveCount(0);
        await expect(panel.getByLabel('Number of B/L C')).toBeVisible();

        // Clearing or typing an out-of-range value preserves parts / snaps back
        await count.fill('');
        await count.press('Tab');
        await expect(count).toHaveValue('3');
        await expect(panel.getByLabel('Number of B/L C')).toBeVisible();

        // Divide cargo across 3 B/Ls; button stays disabled until totals match
        await panel.getByLabel(`B/L A packages of ${CONTAINER_B}`).fill('0');
        await panel.getByLabel(`B/L A weight of ${CONTAINER_B}`).fill('0');
        await panel.getByLabel(`B/L B packages of ${CONTAINER_B}`).fill('200');
        await panel.getByLabel(`B/L B weight of ${CONTAINER_B}`).fill('6000');
        await panel.getByLabel(`B/L A packages of ${CONTAINER_A}`).fill('200');
        await panel.getByLabel(`B/L A weight of ${CONTAINER_A}`).fill('6000');
        await panel.getByLabel(`B/L C packages of ${CONTAINER_A}`).fill('199');
        await panel.getByLabel(`B/L C weight of ${CONTAINER_A}`).fill('6000');
        const send = panel.getByRole('button', {name: 'Split into 3 B/Ls'});
        await expect(send).toBeDisabled();
        await expect(panel.getByRole('list', {name: 'Problems'})).toContainText(
          `${CONTAINER_A}: the parts hold 399 packages; the B/L holds 400.`,
        );

        await panel.getByLabel(`B/L C packages of ${CONTAINER_A}`).fill('200');
        await expect(panel.getByRole('list', {name: 'Problems'})).toHaveCount(
          0,
        );
        await expect(send).toBeEnabled();
        await dismissToasts(page);
        await evidence(
          page,
          'CB-73',
          'Flexible 3-way split with count control and cargo totals',
        );

        await send.click();
        await page
          .getByRole('alertdialog')
          .getByRole('button', {name: 'Split', exact: true})
          .click();
        await expect(page.getByText('B/L split into 3 new B/Ls')).toBeVisible();
        await expect(fact(page, 'State')).toHaveText('Split');
        const replaced = fact(page, 'Replaced by');
        for (const suffix of ['A', 'B', 'C']) {
          await expect(
            replaced.getByRole('link', {name: `${flex.recordNo}-${suffix}`}),
          ).toBeVisible();
        }
      },
    );
  },
);

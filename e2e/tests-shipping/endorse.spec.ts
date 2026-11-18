/**
 * Endorsing a B/L to a named organisation on the shipping app's screens (CB-45, good weather,
 * from the CB-12 design): the B/L travels the blueprint's journey. A carrier issues a B/L to order
 * to the shipper (through the API, as bl-home.spec.ts does); the shipper's trade clerk endorses it
 * on the screen to the exporter's bank, picked from the registered organisations after a
 * confirmation of what happens; the bank's clerk sees it as holder and endorses it to the buyer's
 * bank, which endorses it to the buyer. After each step the new holder is shown on the page, the
 * chain gains the step, and the endorser keeps the B/L in its list as past holder. The
 * organisations and their people are made through the API by the administrator. Screenshots for
 * the ticket with `npm run evidence -- CB-45 --shipping` (support/evidence.ts).
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import {unique} from '../support/admin';
import {trackApi} from '../support/api-idle';
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
import {DEMO_PASSWORD, GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

/** The ticket the screenshots are for. */
const TICKET = 'CB-45';

/** An item of GET /records/title (the fields read here). */
interface ListItem {
  id: string;
  roles: string[];
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'endorsing a B/L to a named organisation on the screens (CB-45)',
  {tag: '@CB-45'},
  () => {
    let api: APIRequestContext;
    let carrier: Organisation;
    let shipper: Organisation;
    let exporterBank: Organisation;
    let buyerBank: Organisation;
    let buyer: Organisation;
    let bl: {id: string; label: string};
    /** How the screenshots' captions call each organisation, by id: its part in the journey. */
    const parts = new Map<string, string>();

    /**
     * An organisation's part in the journey, for a caption (its name is made up per run).
     * @param organisation the organisation
     * @return e.g. "the shipper"
     */
    function partOf(organisation: Organisation): string {
      return parts.get(organisation.id) ?? organisation.name;
    }

    /**
     * The same, to start a caption with.
     * @param organisation the organisation
     * @return e.g. "The shipper"
     */
    function sentenceStartOf(organisation: Organisation): string {
      const part = partOf(organisation);
      return part.charAt(0).toUpperCase() + part.slice(1);
    }

    /**
     * The list of an organisation's user through the API, by B/L id: its roles.
     * @param user the user
     * @return the roles of each B/L
     */
    async function rolesOf(user: SignedIn): Promise<Record<string, string[]>> {
      const res = await api.get('/api/records/title', {headers: user.headers});
      expect(res.status(), await res.text()).toBe(200);
      const items: ListItem[] = (await res.json()).items;
      return Object.fromEntries(items.map(i => [i.id, i.roles]));
    }

    /**
     * Checks a user's home lists the B/L once, with the organisation's role on it and its holder.
     * @param page the page, signed in
     * @param role the role shown
     * @param holder the holder's name
     */
    async function expectOnHome(
      page: Page,
      role: string,
      holder: string,
    ): Promise<void> {
      await page.goto('/#/');
      const table = page.getByRole('table', {name: 'Bills of lading'});
      const row = table.locator('tbody tr').filter({hasText: bl.label});
      await expect(row).toHaveCount(1);
      await expect(row.locator('td').nth(3)).toContainText(holder);
      await expect(row.locator('td').nth(4)).toHaveText(role);
    }

    /**
     * The holder's clerk endorses the B/L on the screen to the next organisation: opens it from
     * the home, picks the organisation, confirms, and sees the new holder and the new step.
     * @param page the page
     * @param from the holder
     * @param to the organisation it is endorsed to
     * @param steps the chain's steps once endorsed
     * @param shots whether to take the screenshots of the picker and the confirmation
     */
    async function endorseOnScreen(
      page: Page,
      from: Organisation,
      to: Organisation,
      steps: number,
      shots: boolean,
    ): Promise<void> {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, from.clerk.email, INVITED_PASSWORD);
      await expectOnHome(page, 'Holder', from.name);

      await page.getByRole('link', {name: `Open ${bl.label}`}).click();
      await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        'Holder',
      );
      const open = page.getByRole('button', {name: 'Endorse to…'});
      await expect(open).toBeVisible();
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        `${sentenceStartOf(from)}: the B/L it holds`,
      );
      await open.click();

      const panel = page.getByRole('region', {name: 'Endorse', exact: true});
      const picker = panel.getByRole('radiogroup', {name: 'Endorse to'});
      await expect(picker).toHaveAccessibleDescription(
        'Organisations registered on the platform.',
      );
      // the focus moves into the panel, to the first organisation
      await expect(picker.getByRole('radio').first()).toBeFocused();
      await expect(picker.getByRole('radio', {name: to.name})).toHaveCount(1);
      // never its own organisation, which is also the current holder
      await expect(picker.getByRole('radio', {name: from.name})).toHaveCount(0);
      const send = panel.getByRole('button', {name: 'Endorse', exact: true});
      await expect(send).toBeDisabled();
      if (shots) {
        // Cancel closes the panel and gives the focus back to "Endorse to…"
        await panel.getByRole('button', {name: 'Cancel'}).click();
        await expect(panel).toHaveCount(0);
        await expect(open).toBeFocused();
        await open.click();
      }
      await picker.getByRole('radio', {name: to.name}).check();
      await expect(panel.getByRole('status')).toHaveText(
        `${to.name} becomes the holder; you can no longer act on this B/L.`,
      );
      if (shots) {
        // the whole page in one picture
        await page.setViewportSize({width: 1440, height: 1700});
        await evidence(
          page,
          TICKET,
          `${sentenceStartOf(from)} picks ${partOf(to)}`,
        );
        await page.setViewportSize({width: 1440, height: 900});
      }

      await send.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Endorse ${bl.label} to ${to.name}?`);
      await expect(dialog).toContainText(
        `${to.name} becomes the holder; you can no longer act on this B/L.`,
      );
      if (shots) {
        await evidence(
          page,
          TICKET,
          'What happens, confirmed before it is done',
        );
      }
      await dialog.getByRole('button', {name: 'Endorse', exact: true}).click();

      await expect(page.locator('dt:text-is("Holder") + dd')).toContainText(
        to.name,
      );
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        'Past holder',
      );
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'With holder',
      );
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(steps);
      const last = chain.locator('tbody tr').last();
      await expect(last).toContainText('Endorsed');
      await expect(last).toContainText(from.name);
      await expect(last).toContainText(to.name);
      // nothing more to do for a past holder
      await expect(page.getByRole('button', {name: 'Endorse to…'})).toHaveCount(
        0,
      );
      await expect(
        page.getByRole('region', {name: 'Endorse', exact: true}),
      ).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, TICKET, `Endorsed to ${partOf(to)}`);

      await expectOnHome(page, 'Past holder', to.name);
      await evidence(
        page,
        TICKET,
        `${sentenceStartOf(from)}: the B/L as past holder`,
      );
    }

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(240_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      const admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
      exporterBank = await organisationWithClerk(
        api,
        admin,
        'ExporterBank',
        TRADE_ROLE,
      );
      buyerBank = await organisationWithClerk(
        api,
        admin,
        'BuyerBank',
        TRADE_ROLE,
      );
      buyer = await organisationWithClerk(api, admin, 'Buyer', TRADE_ROLE);
      parts.set(shipper.id, 'the shipper');
      parts.set(exporterBank.id, "the exporter's bank");
      parts.set(buyerBank.id, "the buyer's bank");
      parts.set(buyer.id, 'the buyer');

      bl = await committedBl(api, carrier.clerk, admin, {
        document: negotiableBl(`CB45${unique().toUpperCase()}`.slice(0, 20)),
        partyOrganisations: {shipper: shipper.id},
        issue: true,
      });
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test("the shipper's trade clerk endorses the B/L to the exporter's bank", async ({
      page,
    }) => {
      await endorseOnScreen(page, shipper, exporterBank, 2, true);
    });

    test("the exporter's bank holds it and endorses it to the buyer's bank", async ({
      page,
    }) => {
      await endorseOnScreen(page, exporterBank, buyerBank, 3, false);
    });

    test("the buyer's bank holds it and endorses it to the buyer", async ({
      page,
    }) => {
      await endorseOnScreen(page, buyerBank, buyer, 4, false);
    });

    test('the buyer holds it, and every previous holder keeps it as past holder', async ({
      page,
    }) => {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, buyer.clerk.email, INVITED_PASSWORD);
      await expectOnHome(page, 'Holder', buyer.name);
      await page.getByRole('link', {name: `Open ${bl.label}`}).click();
      await expect(page.locator('dt:text-is("Holder") + dd')).toContainText(
        buyer.name,
      );
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(4);
      await expect(
        page.getByRole('button', {name: 'Endorse to…'}),
      ).toBeVisible();
      await dismissToasts(page);
      await evidence(page, TICKET, "The buyer's page: it holds the B/L");

      expect((await rolesOf(buyer.clerk))[bl.id]).toEqual(['holder']);
      for (const past of [shipper, exporterBank, buyerBank]) {
        expect((await rolesOf(past.clerk))[bl.id], past.name).toEqual([
          'past-holder',
        ]);
      }
    });

    test('a refusal is shown plainly, and the page is read again', async ({
      page,
    }) => {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, buyer.clerk.email, INVITED_PASSWORD);
      // signed in once the home shows, before going to the B/L's page
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await page.goto(`/#/bls/${bl.id}`);
      await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
      await page.getByRole('button', {name: 'Endorse to…'}).click();
      const panel = page.getByRole('region', {name: 'Endorse', exact: true});
      await panel.getByRole('radio', {name: shipper.name}).check();

      // meanwhile another person of the buyer endorses it to the exporter's bank
      const first = await api.post(`/api/records/${bl.id}/title/endorse`, {
        headers: buyer.clerk.headers,
        data: {to: exporterBank.id, inBlank: false},
      });
      expect(first.status(), await first.text()).toBe(200);

      await panel.getByRole('button', {name: 'Endorse', exact: true}).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', {name: 'Endorse', exact: true})
        .click();
      await expect(page.getByRole('alert')).toContainText(
        'Only the current holder may endorse this B/L',
      );
      // read again: the new holder, and nothing more to do for the buyer
      await expect(page.locator('dt:text-is("Holder") + dd')).toContainText(
        exporterBank.name,
      );
      await expect(page.getByRole('button', {name: 'Endorse to…'})).toHaveCount(
        0,
      );
      await expect(panel).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, TICKET, 'Someone else endorsed it first: refused');
    });

    test('each page loads once: no request loop (the B/L page reloaded without end before)', async ({
      page,
    }) => {
      /** The GET requests the pages make, by what they read. */
      const counts = new Map<string, number>();
      const apiIdle = trackApi(page);
      page.on('request', request => {
        if (request.method() !== 'GET') {
          return;
        }
        const path = new URL(request.url()).pathname;
        let key = '';
        if (path === '/api/records/title') {
          key = 'list';
        } else if (/^\/api\/records\/[0-9a-f-]{36}\/title$/.test(path)) {
          key = 'title';
        } else if (path === '/api/organisations' || path === '/api/users') {
          key = path;
        }
        if (key !== '') {
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      });
      /**
       * Waits until API calls settle on a page that has shown, then checks what it read.
       * @param key what the page reads
       */
      async function expectReadOnce(key: string): Promise<void> {
        await apiIdle(500);
        expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(1);
        expect(counts.get(key) ?? 0, key).toBeLessThanOrEqual(2);
      }

      await page.setViewportSize({width: 1440, height: 900});
      // the carrier sees the B/L whoever holds it, so this test also runs alone
      await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await expectReadOnce('list');
      await page.getByRole('link', {name: `Open ${bl.label}`}).click();
      await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
      await expectReadOnce('title');

      // the administrator's page of an organisation
      await page.goto('/#/');
      await page.getByRole('button', {name: 'Sign out'}).click();
      counts.clear();
      await signInOnScreen(page, demoEmails('adm')[0], DEMO_PASSWORD);
      await expect(page).not.toHaveURL(/login/);
      await expect(page.getByRole('button', {name: 'Sign out'})).toBeVisible();
      await page.goto(`/#/admin/organisations/${buyer.id}`);
      await expect(page.getByText(buyer.name).first()).toBeVisible();
      await expectReadOnce('/api/organisations');
      await expectReadOnce('/api/users');
    });
  },
);

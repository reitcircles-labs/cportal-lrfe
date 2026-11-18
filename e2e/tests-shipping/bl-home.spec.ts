/**
 * The shipping app's home (CB-42): a user of each organisation sees exactly the B/Ls their
 * organisation is party to, and opens one. Four organisations are made here by the administrator,
 * each with a B/L clerk: a carrier, a shipper, a bank and an outsider. The carrier issues a B/L
 * to order to the shipper, who endorses it to the bank; the carrier also keeps a draft. Then the
 * carrier sees both (as carrier), the shipper the issued one (as past holder), the bank the same
 * (as holder), the outsider none; through the API and on the screen, every organisation shown by
 * its name. Screenshots for the ticket
 * with `npm run evidence -- CB-42` conventions (support/evidence.ts).
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
  type SignedIn,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

/** An item of GET /records/title (the fields read here). */
interface ListItem {
  id: string;
  label: string;
  roles: string[];
}

/**
 * A new transport document reference (DCSA allows 20 characters).
 * @return the reference
 */
function reference(): string {
  return `CB42${unique().toUpperCase()}`.slice(0, 20);
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  "an organisation's B/Ls on the shipping app's home (CB-42)",
  {tag: '@CB-42'},
  () => {
    let api: APIRequestContext;
    let admin: SignedIn;
    let carrier: Organisation;
    let shipper: Organisation;
    let bank: Organisation;
    let outsider: Organisation;
    let issued: {id: string; label: string};
    let draft: {id: string; label: string};

    /**
     * Creates a B/L of the carrier, linked to the shipper: its id and label.
     * @return the B/L
     */
    async function createBl(): Promise<{id: string; label: string}> {
      const created = await api.post('/api/records', {
        headers: carrier.clerk.headers,
        data: {
          format: 'dcsa-3.0',
          document: negotiableBl(reference()),
          partyOrganisations: {shipper: shipper.id},
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      const record = await created.json();
      return {id: record.id, label: record.label};
    }

    /**
     * Runs a title command expected to succeed.
     * @param id the B/L
     * @param name the command
     * @param user the caller
     * @param data its arguments
     */
    async function run(id: string, name: string, user: SignedIn, data = {}) {
      const res = await api.post(`/api/records/${id}/title/${name}`, {
        headers: user.headers,
        data,
      });
      expect(res.status(), `${name}: ${await res.text()}`).toBe(200);
    }

    /**
     * The list of an organisation's user through the API.
     * @param user the user
     * @return the items
     */
    async function listOf(user: SignedIn): Promise<ListItem[]> {
      const res = await api.get('/api/records/title', {headers: user.headers});
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()).items;
    }

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(180_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
      bank = await organisationWithClerk(api, admin, 'Bank', TRADE_ROLE);
      outsider = await organisationWithClerk(
        api,
        admin,
        'Outsider',
        TRADE_ROLE,
      );

      issued = await committedBl(api, carrier.clerk, admin, {
        document: negotiableBl(reference()),
        partyOrganisations: {shipper: shipper.id},
        issue: true,
      });
      await run(issued.id, 'endorse', shipper.clerk, {
        to: bank.id,
        inBlank: false,
      });

      draft = await createBl();
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('through the API each organisation lists exactly the B/Ls it is party to, with its role', async () => {
      const roles = (items: ListItem[]) =>
        Object.fromEntries(items.map(i => [i.id, i.roles]));
      expect(roles(await listOf(carrier.clerk))).toEqual({
        [issued.id]: ['carrier'],
        [draft.id]: ['carrier'],
      });
      expect(roles(await listOf(shipper.clerk))).toEqual({
        [issued.id]: ['past-holder'],
      });
      expect(roles(await listOf(bank.clerk))).toEqual({
        [issued.id]: ['holder'],
      });
      expect(await listOf(outsider.clerk)).toEqual([]);
    });

    /** What each organisation's user sees on the home: the B/Ls, by label, with their role. */
    const homes: Array<{
      who: () => Organisation;
      rows: () => Array<{label: string; role: string}>;
      opens: boolean;
    }> = [
      {
        who: () => carrier,
        rows: () => [
          {label: draft.label, role: 'Carrier'},
          {label: issued.label, role: 'Carrier'},
        ],
        opens: true,
      },
      {
        who: () => shipper,
        rows: () => [{label: issued.label, role: 'Past holder'}],
        opens: true,
      },
      {
        who: () => bank,
        rows: () => [{label: issued.label, role: 'Holder'}],
        opens: true,
      },
      {who: () => outsider, rows: () => [], opens: false},
    ];

    for (const [i, home] of homes.entries()) {
      test(`on the screen, user ${i + 1} of 4 sees exactly their organisation's B/Ls and opens one`, async ({
        page,
      }) => {
        const organisation = home.who();
        const label = organisation.name.split(' ')[1];
        await page.setViewportSize({width: 1440, height: 900});
        await signInOnScreen(page, organisation.clerk.email, INVITED_PASSWORD);
        await expect(
          page.getByRole('heading', {name: 'Bills of lading'}),
        ).toBeVisible();
        await expect(
          page.getByText(`Signed in as ${organisation.clerk.name}`),
        ).toBeVisible();

        const table = page.getByRole('table', {name: 'Bills of lading'});
        const expected = home.rows();
        if (expected.length === 0) {
          await expect(
            table.getByText('Your organisation is not party to any B/L yet.'),
          ).toBeVisible();
          await evidence(page, 'CB-42', `${label}: no B/Ls`);
          return;
        }
        const rows = table.locator('tbody tr');
        await expect(rows).toHaveCount(expected.length);
        for (const [n, row] of expected.entries()) {
          await expect(rows.nth(n)).toContainText(row.label);
          await expect(rows.nth(n).locator('td').nth(4)).toHaveText(row.role);
        }
        // organisations are shown by name: the issued B/L's holder is the bank
        const issuedRow = rows.filter({hasText: issued.label});
        await expect(issuedRow.locator('td').nth(3)).toContainText(bank.name);
        await evidence(page, 'CB-42', `${label}: the home list`);

        if (home.opens) {
          await page.getByRole('link', {name: `Open ${issued.label}`}).click();
          await expect(
            page.getByRole('heading', {name: issued.label}),
          ).toBeVisible();
          const role = expected.find(r => r.label === issued.label)?.role ?? '';
          await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
            role,
          );
          const chain = page.getByRole('table', {name: 'Chain of title'});
          await expect(chain.locator('tbody tr')).toHaveCount(2);
          await expect(chain.locator('tbody tr').nth(0)).toContainText(
            'Issued',
          );
          await expect(chain.locator('tbody tr').nth(1)).toContainText(
            'Endorsed',
          );
          // the step's organisations and the B/L's parties by name
          await expect(chain.locator('tbody tr').nth(1)).toContainText(
            shipper.name,
          );
          await expect(chain.locator('tbody tr').nth(1)).toContainText(
            bank.name,
          );
          await expect(
            page.locator('dt:text-is("Carrier") + dd'),
          ).toContainText(carrier.name);
          await evidence(page, 'CB-42', `${label}: the B/L's page`);
        }
      });
    }

    test('a B/L the organisation is not party to is not found on its page', async ({
      page,
    }) => {
      await signInOnScreen(page, outsider.clerk.email, INVITED_PASSWORD);
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await page.goto(`/#/bls/${issued.id}`);
      await expect(page.getByRole('alert')).toContainText('B/L not found');
      await evidence(page, 'CB-42', 'Outsider: a B/L of others is not found');
    });
  },
);

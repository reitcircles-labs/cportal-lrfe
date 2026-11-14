/**
 * Onboarding on the shipping app's screens (CB-43): the platform administrator adds a carrier, a
 * shipper, two banks and a buyer, and invites one person into each with the B/L role. Then the
 * carrier's and the shipper's people accept their invitations; the carrier issues a B/L to order
 * to the shipper (through the API, as CB-42 does), and the shipper's person signs in on the screen
 * and finds it on the home, held by their organisation. Screenshots for the ticket with
 * `npm run evidence -- CB-43 --shipping` (support/evidence.ts).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import {officeCode, unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  acceptInvitation,
  demoEmails,
  serviceToken,
  signIn,
  signInOnScreen,
  type SignedIn,
} from '../support/shipping';
import {
  DEMO_PASSWORD,
  GATEWAY_URL,
  REPO_DIR,
  SHIPPING_URL,
} from '../stack/config.mjs';

/** An organisation onboarded on the screens, and the person invited into it. */
interface Onboarded {
  label: string;
  name: string;
  code: string;
  id: string;
  person: {name: string; email: string};
}

/** The organisations the administrator onboards, in order. */
const LABELS = ['Carrier', 'Shipper', 'Bank 1', 'Bank 2', 'Buyer'];

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

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'onboarding organisations and their staff on the screens (CB-43)',
  {tag: '@CB-43'},
  () => {
    let api: APIRequestContext;
    let admin: SignedIn;
    const run = unique();
    const onboarded: Onboarded[] = LABELS.map(label => {
      const word = label.toLowerCase().replace(' ', '');
      return {
        label,
        name: `E2E ${label} ${run}`,
        code: officeCode(),
        id: '',
        person: {
          name: `${label} clerk ${run}`,
          email: `e2e.onboard.${word}.${run}@shipping.example`,
        },
      };
    });

    /**
     * The buyer, onboarded last.
     * @return the buyer
     */
    function buyer(): Onboarded {
      return onboarded[onboarded.length - 1];
    }

    test.beforeAll(async ({playwright}) => {
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      // signs the administrator in once through the API, which enrols the authenticator
      admin = await signIn(api, demoEmails('adm')[0]);
      // an office of another organisation already has the buyer's code: the buyer's first office
      // takes a free one (review of CB-43)
      const office = await api.post('/api/offices', {
        headers: admin.headers,
        data: {
          code: buyer().code,
          name: `Office with the buyer's code ${run}`,
          type: 'external',
        },
      });
      expect(office.status(), await office.text()).toBe(201);
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('the administrator adds five organisations and invites a person into each', async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, admin.email, DEMO_PASSWORD);
      // the administrator, who reads no B/Ls, lands on the organisations
      await expect(
        page.getByRole('heading', {name: 'Organisations', level: 1}),
      ).toBeVisible();
      await expect(
        page.getByRole('link', {name: 'Organisations'}),
      ).toBeVisible();

      for (const [i, organisation] of onboarded.entries()) {
        await page
          .getByLabel('Name of the organisation')
          .fill(organisation.name);
        await page.getByLabel('Code').fill(organisation.code.toLowerCase());
        if (i === 0) {
          await dismissToasts(page);
          await evidence(page, 'CB-43', 'Adding the carrier');
        }
        await page.getByRole('button', {name: 'Add organisation'}).click();

        // the new organisation's page, with no staff yet
        await expect(
          page.getByRole('heading', {name: organisation.name, level: 1}),
        ).toBeVisible();
        await expect(
          page.getByText(organisation.code, {exact: true}),
        ).toBeVisible();
        const staff = page.getByRole('table', {name: 'Staff'});
        await expect(staff.locator('tbody tr')).toHaveCount(1);
        await expect(staff).toContainText('No staff yet.');
        organisation.id = page.url().split('/').pop() ?? '';

        await page.getByLabel('Full name').fill(organisation.person.name);
        await page.getByLabel('Email').fill(organisation.person.email);
        await page.getByRole('checkbox', {name: 'B/L documentation'}).check();
        // the system administrator's role is not offered to an organisation's staff
        await expect(
          page.getByRole('checkbox', {name: 'System administrator'}),
        ).toHaveCount(0);
        await page.getByRole('button', {name: 'Send invitation'}).click();

        const row = staff.locator('tbody tr', {
          hasText: organisation.person.name,
        });
        await expect(row).toContainText(organisation.person.email);
        await expect(row).toContainText('B/L documentation');
        await expect(row).toContainText('Invited');
        await expect(staff.locator('tbody tr')).toHaveCount(1);
        if (i === 0) {
          await dismissToasts(page);
          await evidence(page, 'CB-43', 'The carrier with its invited clerk');
        }

        await page.getByRole('link', {name: 'All organisations'}).click();
        await expect(
          page.getByRole('heading', {name: 'Organisations', level: 1}),
        ).toBeVisible();
      }

      const list = page.getByRole('table', {name: 'Organisations'});
      for (const organisation of onboarded) {
        const row = list.locator('tbody tr', {hasText: organisation.name});
        await expect(row).toContainText(organisation.code);
        await expect(row).toContainText('Active');
        await expect(row.locator('td').nth(2)).toHaveText('1');
      }
      await dismissToasts(page);
      await evidence(page, 'CB-43', 'The five organisations onboarded');
    });

    test('identity has each person in their organisation, with the B/L role', async () => {
      const res = await api.get('/api/users', {headers: admin.headers});
      expect(res.status(), await res.text()).toBe(200);
      const users: Array<{
        email: string;
        organisationId: string;
        roles: string[];
        status: string;
        officeCode: string;
      }> = (await res.json()).users;
      for (const organisation of onboarded) {
        const person = users.find(u => u.email === organisation.person.email);
        expect(person, organisation.person.email).toBeTruthy();
        expect(person?.organisationId).toBe(organisation.id);
        expect(person?.roles).toEqual(['bld']);
        expect(person?.status).toBe('Invited');
      }
      // the buyer's code was taken by another office: its office has a free code of the same stem
      const buyerOffice =
        users.find(u => u.email === buyer().person.email)?.officeCode ?? '';
      expect(buyerOffice).toMatch(/^[A-Z]{2,5}$/);
      expect(buyerOffice).not.toBe(buyer().code);
      expect(buyerOffice.slice(0, 4)).toBe(buyer().code.slice(0, 4));
    });

    test("the shipper's person signs in and finds the B/L their organisation holds", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const [carrier, shipper] = onboarded;
      for (const organisation of [carrier, shipper]) {
        await acceptInvitation(api, organisation.person.email);
      }
      const carrierClerk = await signIn(
        api,
        carrier.person.email,
        INVITED_PASSWORD,
      );
      const shipperClerk = await signIn(
        api,
        shipper.person.email,
        INVITED_PASSWORD,
      );
      expect(carrierClerk.organisationId).toBe(carrier.id);
      expect(shipperClerk.organisationId).toBe(shipper.id);

      // the carrier issues a B/L to order to the shipper, as on the CB-42 home
      const created = await api.post('/api/records', {
        headers: carrierClerk.headers,
        data: {
          format: 'dcsa-3.0',
          document: negotiableBl(`CB43${unique().toUpperCase()}`.slice(0, 20)),
          partyOrganisations: {shipper: shipper.id},
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      const bl = await created.json();
      const submitted = await api.post(
        `/api/records/${bl.id}/versions/1/submit`,
        {
          headers: carrierClerk.headers,
        },
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
        headers: carrierClerk.headers,
        data: {},
      });
      expect(issued.status(), await issued.text()).toBe(200);

      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, shipper.person.email, INVITED_PASSWORD);
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await expect(
        page.getByText(`Signed in as ${shipper.person.name} · ${shipper.name}`),
      ).toBeVisible();
      // no administration for the organisation's staff
      await expect(page.getByRole('link', {name: 'Organisations'})).toHaveCount(
        0,
      );
      const rows = page
        .getByRole('table', {name: 'Bills of lading'})
        .locator('tbody tr');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(bl.label);
      await expect(rows.first().locator('td').nth(3)).toHaveText(
        `${shipper.name} (your organisation)`,
      );
      await expect(rows.first().locator('td').nth(4)).toHaveText('Holder');
      await dismissToasts(page);
      await evidence(page, 'CB-43', "The shipper's clerk on their home");
    });

    test("the shipper's person is refused the organisations and an organisation's page", async ({
      page,
    }) => {
      const [carrier, shipper] = onboarded;
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, shipper.person.email, INVITED_PASSWORD);
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      const refused = page.getByRole('heading', {
        name: 'You are not allowed to see this page',
      });

      await page.goto('/#/admin/organisations');
      await expect(refused).toBeVisible();
      await expect(
        page.getByRole('table', {name: 'Organisations'}),
      ).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, 'CB-43', 'A B/L clerk is refused the organisations');

      await page.goto(`/#/admin/organisations/${carrier.id}`);
      await expect(refused).toBeVisible();
      await expect(page.getByRole('table', {name: 'Staff'})).toHaveCount(0);
      await expect(page.getByText(carrier.name)).toHaveCount(0);
    });
  },
);

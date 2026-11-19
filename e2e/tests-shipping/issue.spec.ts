/**
 * Issuing a B/L on the shipping app's screens (CB-44, good weather, from the CB-11 design): a
 * carrier's clerk drafts a B/L on the "New B/L" screen, the shipper picked from the organisations
 * on the platform, and submits it for approval; the same clerk cannot approve it (four eyes, on
 * the screen and through the API); a second person of the carrier sees "Waiting for your
 * approval", approves it and issues it to the shipper; the shipper's clerk sees it on their home,
 * as its holder. The organisations and their people are made through the API by the
 * administrator, as bl-home.spec.ts does. Screenshots for the ticket with
 * `npm run evidence -- CB-44 --shipping` (support/evidence.ts).
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
  acceptInvitation,
  demoEmails,
  dismissToasts,
  TRADE_ROLE,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
  type SignedIn,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

/**
 * Invites a second person with the B/L role into an organisation, through the API as the
 * administrator: activated and signed in.
 * @param api the request context, on the gateway
 * @param admin the signed-in administrator
 * @param organisation the organisation
 * @return the person, signed in
 */
async function secondPerson(
  api: APIRequestContext,
  admin: SignedIn,
  organisation: Organisation,
): Promise<SignedIn> {
  const offices = await api.get('/api/offices', {headers: admin.headers});
  expect(offices.status(), await offices.text()).toBe(200);
  const office = (await offices.json()).offices.find(
    (o: {organisationId: string | null}) =>
      o.organisationId === organisation.id,
  );
  expect(office, 'the organisation has an office').toBeTruthy();
  const id = unique();
  const email = `e2e.approver.${id}@shipping.example`;
  const invited = await api.post('/api/users', {
    headers: admin.headers,
    data: {
      name: `Approver ${id}`,
      email,
      officeId: office.id,
      organisationId: organisation.id,
      roles: ['bld'],
    },
  });
  expect(invited.status(), await invited.text()).toBe(201);
  await acceptInvitation(api, email);
  return signIn(api, email, INVITED_PASSWORD);
}

/**
 * Fills a field of the new B/L form by its label.
 * @param page the page
 * @param label the field's label
 * @param value its value
 */
async function fill(page: Page, label: string, value: string): Promise<void> {
  await page.getByLabel(label, {exact: true}).fill(value);
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'issuing a B/L on the screens: draft, four-eyes approval, issue (CB-44)',
  {tag: '@CB-44'},
  () => {
    let api: APIRequestContext;
    let admin: SignedIn;
    let carrier: Organisation;
    let approver: SignedIn;
    let shipper: Organisation;
    let blId = '';
    let label = '';
    const reference = `CB44${unique().toUpperCase()}`.slice(0, 20);

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(180_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      approver = await secondPerson(api, admin, carrier);
      shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test("the carrier's clerk drafts a B/L and submits it; they cannot approve it themselves", async ({
      page,
    }) => {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await page.getByRole('link', {name: 'New B/L'}).click();
      await expect(page.getByRole('heading', {name: 'New B/L'})).toBeVisible();

      await fill(page, 'B/L number', reference);
      await page.getByLabel('Carrier code', {exact: true}).selectOption('MSC');
      await fill(page, 'Booking reference', 'BKG-884120');
      await page.getByLabel('Shipper', {exact: true}).selectOption({
        label: shipper.name,
      });
      await fill(page, 'Street', 'Harbour Road 4');
      await fill(page, 'City', 'Port Town');
      await fill(page, 'Country code', 'NA');
      await fill(page, 'Vessel', 'Atlantic Crest');
      await fill(page, 'Voyage', '2611N');
      await fill(page, 'Port of loading', 'NAWVB');
      await fill(page, 'Port of discharge', 'NLRTM');
      await fill(page, 'Planned departure', '2026-11-20');
      await fill(page, 'Planned arrival', '2026-12-08');
      await fill(page, 'Container number', 'MSKU7045123');
      await fill(page, 'Seal number', 'SL220871');
      await fill(page, 'Goods', '640 bags of green coffee');
      await fill(page, 'HS code', '090111');
      await fill(page, 'Number of packages', '640');
      await fill(page, 'Kind of packages', 'Bags');
      await fill(page, 'Gross weight (kg)', '38040');
      // the whole form in one picture
      await page.setViewportSize({width: 1440, height: 2300});
      await evidence(page, 'CB-44', 'The carrier clerk drafts a new B/L');
      await page.setViewportSize({width: 1440, height: 900});

      await page.getByRole('button', {name: 'Save draft'}).click();
      await expect(page).toHaveURL(/#\/bls\/[0-9a-f-]{36}$/);
      blId = page.url().split('/').at(-1) ?? '';
      label = `B/L ${reference} (MSC)`;
      await expect(page.getByRole('heading', {name: label})).toBeVisible();
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Draft',
      );

      await page.getByRole('button', {name: 'Submit for approval'}).click();
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'In review',
      );
      const approval = page.getByRole('region', {name: 'Approval'});
      await expect(approval).toContainText(
        'You prepared this draft, so a second person must approve it.',
      );
      await expect(approval).toContainText(shipper.name);
      await expect(page.getByRole('button', {name: 'Approve'})).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, 'CB-44', 'Submitted: the clerk cannot approve it');

      // the record service refuses it too: never the drafter (four eyes)
      const own = await api.post(`/api/records/${blId}/versions/1/approve`, {
        headers: carrier.clerk.headers,
        data: {},
      });
      expect(own.status(), await own.text()).toBe(403);
      expect((await own.json()).details?.code).toBe('own-draft');
    });

    test('a second person of the carrier approves it and issues it to the shipper', async ({
      page,
    }) => {
      expect(blId).not.toBe('');
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, approver.email, INVITED_PASSWORD);
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await page.getByRole('link', {name: `Open ${label}`}).click();
      const approval = page.getByRole('region', {name: 'Approval'});
      await expect(approval).toContainText('Waiting for your approval');
      await expect(approval).toContainText(carrier.clerk.name);
      // the shipper is the linked organisation, by name, and nothing needs a warning
      await expect(
        approval.locator('dt:text-is("Shipper") + dd'),
      ).toContainText(shipper.name);
      await expect(approval.getByRole('note')).toHaveCount(0);
      await expect(page.locator('dt:text-is("Kind") + dd').first()).toHaveText(
        'Negotiable B/L',
      );
      await evidence(
        page,
        'CB-44',
        'Waiting for the approval of a second person',
      );

      await page.getByRole('button', {name: 'Approve'}).click();
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Ready to issue',
      );
      const issue = page.getByRole('button', {name: 'Issue to the shipper'});
      await expect(issue).toBeVisible();
      // the approved B/L stays in view at the issue (design step 3.2)
      await expect(approval).toContainText(
        `Approved by ${approver.name}: ready to issue.`,
      );
      await expect(approval).toContainText(shipper.name);
      await dismissToasts(page);
      await evidence(page, 'CB-44', 'Approved: ready to issue');

      await issue.click();
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Issued',
      );
      await expect(page.locator('dt:text-is("Holder") + dd')).toContainText(
        shipper.name,
      );
      // a B/L to order names no consignee, after issue as before
      await expect(page.locator('dt:text-is("Consignee") + dd')).toHaveText(
        'None: to order',
      );
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(1);
      await expect(chain.locator('tbody tr').first()).toContainText('Issued');
      await expect(page.getByRole('region', {name: 'Approval'})).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, 'CB-44', 'Issued to the shipper');
    });

    test("the shipper's clerk sees the issued B/L on their home, as its holder", async ({
      page,
    }) => {
      expect(blId).not.toBe('');
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, shipper.clerk.email, INVITED_PASSWORD);
      const table = page.getByRole('table', {name: 'Bills of lading'});
      const row = table.locator('tbody tr').filter({hasText: label});
      await expect(row).toHaveCount(1);
      await expect(row.locator('td').nth(2)).toHaveText('Issued');
      await expect(row.locator('td').nth(4)).toHaveText('Holder');
      // the shipper's staff (the trade role) draft no B/Ls
      await expect(page.getByRole('link', {name: 'New B/L'})).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, 'CB-44', "The shipper's home: the B/L it holds");

      await page.getByRole('link', {name: `Open ${label}`}).click();
      await expect(page.getByRole('heading', {name: label})).toBeVisible();
      await expect(page.locator('dt:text-is("Carrier") + dd')).toContainText(
        carrier.name,
      );
      // the shipper has no carrier's action on it
      await expect(
        page.getByRole('button', {name: 'Issue to the shipper'}),
      ).toHaveCount(0);
      await evidence(page, 'CB-44', "The shipper's page of the B/L");
    });
  },
);

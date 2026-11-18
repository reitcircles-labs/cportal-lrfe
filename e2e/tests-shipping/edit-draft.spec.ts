/**
 * Editing a draft B/L before approval (CB-70, agreed design):
 * - Its author (never another user of the carrier) sees "Edit" on the B/L's page while the draft
 *   is unapproved (before submit, while in review, and after sent back).
 * - "Edit" opens the B/L form filled in with the draft; the B/L number and carrier code stay
 *   locked; saving updates the same draft (and keeps it in review when edited in review).
 * - An approver looking at an older revision while the author edits in review is refused when
 *   approving, and the page reloads with the updated draft.
 * Screenshots with `npm run evidence -- CB-70 --spec tests-shipping/edit-draft.spec.ts`.
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
  negotiableBl,
  TRADE_ROLE,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
  type SignedIn,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

const TICKET = 'CB-70';

/**
 * Invites a second carrier user (who drafts and approves/issues B/Ls) into the organisation.
 * @param api gateway request context
 * @param admin signed-in admin
 * @param organisation carrier organisation
 * @return the second person, signed in
 */
async function secondCarrierUser(
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
  expect(office).toBeTruthy();
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
 * Opens the B/L's page from the signed-in user's home.
 * @param page browser page
 * @param email user email
 * @param label B/L label
 */
async function openBl(page: Page, email: string, label: string): Promise<void> {
  await page.setViewportSize({width: 1440, height: 900});
  await signInOnScreen(page, email, INVITED_PASSWORD);
  await page.getByRole('link', {name: `Open ${label}`}).click();
  await expect(page.getByRole('heading', {name: label})).toBeVisible();
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'editing a draft B/L before approval on the screens (CB-70)',
  {tag: '@CB-70'},
  () => {
    let api: APIRequestContext;
    let carrier: Organisation;
    let approver: SignedIn;
    let shipper: Organisation;
    let blId = '';
    let blLabel = '';
    const reference = `CB70${unique().toUpperCase()}`.slice(0, 20);

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(180_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      const admin = await signIn(api, demoEmails('adm')[0]);
      carrier = await organisationWithClerk(api, admin, 'Carrier');
      approver = await secondCarrierUser(api, admin, carrier);
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
      blId = record.id;
      blLabel = record.label;
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('the author edits the draft, keeps number and carrier code locked, and saves changes', async ({
      page,
    }) => {
      await openBl(page, carrier.clerk.email, blLabel);
      const edit = page.getByRole('link', {name: 'Edit'});
      await expect(edit).toBeVisible();
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'Author sees Edit on their unsubmitted draft',
      );

      await edit.click();
      await expect(page).toHaveURL(new RegExp(`#/bls/${blId}/edit$`));
      await expect(
        page.getByRole('heading', {name: 'Edit draft B/L'}),
      ).toBeVisible();
      await expect(page.getByLabel('B/L number')).toBeDisabled();
      await expect(page.getByLabel('Carrier code')).toBeDisabled();

      await page
        .getByLabel('Goods', {exact: true})
        .fill('720 bags washed Arabica');
      await page.getByLabel('Port of discharge', {exact: true}).fill('NLRTM');
      await expect(page.getByTestId('bl-portOfDischarge-name')).toHaveText(
        'Rotterdam, Netherlands',
      );
      // Full-page view so the header, locked B/L number & carrier code, and updated fields all fit
      await page.setViewportSize({width: 1440, height: 2300});
      await evidence(
        page,
        TICKET,
        'Edit form filled from the draft, number and carrier code locked, goods updated',
      );
      await page.setViewportSize({width: 1440, height: 900});

      // Same client-side check as create form, then restore and save
      await page.getByLabel('Goods', {exact: true}).fill(' ');
      await page.getByRole('button', {name: 'Save changes'}).click();
      await expect(page.getByText('Fill in the goods.')).toBeVisible();
      await page
        .getByLabel('Goods', {exact: true})
        .fill('720 bags washed Arabica');

      await page.getByRole('button', {name: 'Save changes'}).click();
      await expect(page).toHaveURL(new RegExp(`#/bls/${blId}$`));
      const approval = page.getByRole('region', {name: 'Approval'});
      await expect(approval).toContainText('720 bags washed Arabica');
      await expect(approval).toContainText('NLRTM');
      await dismissToasts(page);
      await evidence(page, TICKET, 'Saved changes shown on the B/L page');
    });

    test('another person of the carrier sees no Edit button and cannot edit via API', async ({
      page,
    }) => {
      await openBl(page, approver.email, blLabel);
      await expect(page.getByRole('link', {name: 'Edit'})).toHaveCount(0);

      const refused = await api.put(`/api/records/${blId}/draft`, {
        headers: approver.headers,
        data: {
          format: 'dcsa-3.0',
          document: negotiableBl(reference),
          partyOrganisations: {shipper: shipper.id},
        },
      });
      expect(refused.status(), await refused.text()).toBe(403);
      expect((await refused.json()).details?.code).toBe('not-author');
    });

    test('editing while in review keeps it in review and refuses stale approval', async ({
      page,
    }) => {
      const submitted = await api.post(
        `/api/records/${blId}/versions/1/submit`,
        {
          headers: carrier.clerk.headers,
        },
      );
      expect(submitted.status(), await submitted.text()).toBe(200);

      // Approver opens the B/L in review (and sees no Edit action)
      await openBl(page, approver.email, blLabel);
      await expect(page.getByRole('link', {name: 'Edit'})).toHaveCount(0);
      await expect(page.getByRole('button', {name: 'Approve'})).toBeVisible();

      // Meanwhile, the author edits the draft while it is in review
      const current = await (
        await api.get(`/api/records/${blId}`, {headers: carrier.clerk.headers})
      ).json();
      const updatedDoc = {
        ...current.draft.data.document,
        consignmentItems: [
          {
            ...current.draft.data.document.consignmentItems[0],
            descriptionOfGoods: ['800 bags organic coffee'],
          },
        ],
      };
      const saved = await api.put(`/api/records/${blId}/draft`, {
        headers: carrier.clerk.headers,
        data: {
          format: 'dcsa-3.0',
          document: updatedDoc,
          partyOrganisations: {shipper: shipper.id},
          revision: current.draft.revision,
        },
      });
      expect(saved.status(), await saved.text()).toBe(200);
      expect(await saved.json()).toMatchObject({draftState: 'in_review'});

      // Approver clicks Approve on the stale page -> refused and reloaded with new text
      await page.getByRole('button', {name: 'Approve'}).click();
      await expect(page.getByRole('alert')).toContainText(
        'This B/L changed meanwhile. The page now shows it as it is.',
      );
      await expect(page.getByRole('region', {name: 'Approval'})).toContainText(
        '800 bags organic coffee',
      );
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'Stale approval refused after author edited in review; page reloaded',
      );

      // Approver now approves the fresh revision, and Edit is gone after approval
      await page.getByRole('button', {name: 'Approve'}).click();
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Ready to issue',
      );
      await expect(page.getByRole('link', {name: 'Edit'})).toHaveCount(0);
    });
  },
);

/**
 * Copying an existing B/L into a new draft (CB-69, agreed design):
 * - A carrier user with `bl.draft` sees "Copy" on any non-archived B/L of their organisation,
 *   whether a draft or an issued B/L in any state (including accomplished).
 * - "Copy" opens the create form pre-filled from that B/L with only the four shipment-specific
 *   fields (B/L number, booking reference, container number, seal number) left empty and marked.
 * - Saving runs the normal checks including the duplicate B/L number check and creates an
 *   independent new draft with no link to the original.
 * - Other organisations (shipper, holder, even with `bl.draft` in their own organisation) never
 *   see Copy and cannot copy another carrier's B/L.
 * Screenshots with `npm run evidence -- CB-69 --spec tests-shipping/copy-bl.spec.ts`.
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

const TICKET = 'CB-69';

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe('copying an existing B/L (CB-69)', {tag: '@CB-69'}, () => {
  let api: APIRequestContext;
  let admin: SignedIn;
  let carrier: Organisation;
  let shipper: Organisation;
  let otherCarrier: Organisation;
  let accomplishedId = '';
  let accomplishedLabel = '';
  let draftLabel = '';
  let endorsedId = '';
  let endorsedLabel = '';
  const accomplishedRef = `CB69A${unique().toUpperCase()}`.slice(0, 20);
  const draftRef = `CB69D${unique().toUpperCase()}`.slice(0, 20);
  const endorsedRef = `CB69E${unique().toUpperCase()}`.slice(0, 20);
  const copyRef = `CB69C${unique().toUpperCase()}`.slice(0, 20);

  test.beforeAll(async ({playwright}) => {
    test.setTimeout(180_000);
    api = await playwright.request.newContext({baseURL: GATEWAY_URL});
    admin = await signIn(api, demoEmails('adm')[0]);
    carrier = await organisationWithClerk(api, admin, 'Carrier');
    shipper = await organisationWithClerk(api, admin, 'Shipper', TRADE_ROLE);
    otherCarrier = await organisationWithClerk(api, admin, 'OtherCarrier');

    // Accomplished B/L: issued -> surrendered -> goods released
    const accomplished = await committedBl(api, carrier.clerk, admin, {
      document: negotiableBl(accomplishedRef),
      partyOrganisations: {shipper: shipper.id},
      issue: true,
    });
    accomplishedId = accomplished.id;
    accomplishedLabel = accomplished.label;
    const surrendered = await api.post(
      `/api/records/${accomplishedId}/title/surrender`,
      {headers: shipper.clerk.headers, data: {}},
    );
    expect(surrendered.status(), await surrendered.text()).toBe(200);
    const released = await api.post(
      `/api/records/${accomplishedId}/title/release`,
      {headers: carrier.clerk.headers, data: {}},
    );
    expect(released.status(), await released.text()).toBe(200);

    // Unsubmitted draft of the carrier
    const draftRes = await api.post('/api/records', {
      headers: carrier.clerk.headers,
      data: {
        format: 'dcsa-3.0',
        document: negotiableBl(draftRef),
        partyOrganisations: {shipper: shipper.id},
      },
    });
    expect(draftRes.status(), await draftRes.text()).toBe(201);
    draftLabel = (await draftRes.json()).label;

    // Issued B/L endorsed to another carrier-role organisation (holder, not carrier on this B/L)
    const endorsed = await committedBl(api, carrier.clerk, admin, {
      document: negotiableBl(endorsedRef),
      partyOrganisations: {shipper: shipper.id},
      issue: true,
    });
    endorsedId = endorsed.id;
    endorsedLabel = endorsed.label;
    const endorseRes = await api.post(
      `/api/records/${endorsedId}/title/endorse`,
      {
        headers: shipper.clerk.headers,
        data: {to: otherCarrier.id, inBlank: false},
      },
    );
    expect(endorseRes.status(), await endorseRes.text()).toBe(200);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('carrier copies an accomplished B/L into a new draft with shipment fields empty and marked', async ({
    page,
  }) => {
    await page.setViewportSize({width: 1440, height: 900});
    await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
    await page.getByRole('link', {name: `Open ${accomplishedLabel}`}).click();
    await expect(
      page.getByRole('heading', {name: accomplishedLabel}),
    ).toBeVisible();
    await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
      'Accomplished',
    );
    await expect(page.getByRole('link', {name: 'Edit'})).toHaveCount(0);

    const copyLink = page.getByRole('link', {name: 'Copy', exact: true});
    await expect(copyLink).toBeVisible();
    await dismissToasts(page);
    await evidence(
      page,
      TICKET,
      'Carrier sees Copy on an accomplished B/L page',
    );

    await copyLink.click();
    await expect(page).toHaveURL(
      new RegExp(`#/bls/new\\?copy=${accomplishedId}$`),
    );
    await expect(page.getByRole('heading', {name: 'New B/L'})).toBeVisible();
    await expect(
      page.getByText(
        `Copied from ${accomplishedLabel}. Fill in the highlighted`,
      ),
    ).toBeVisible();

    // The four shipment-specific fields are empty and marked
    for (const label of [
      'B/L number',
      'Booking reference',
      'Container number',
      'Seal number',
    ]) {
      const field = page.getByLabel(label, {exact: true});
      await expect(field).toHaveValue('');
      await expect(field).toHaveClass(/copy-blank/);
    }
    await expect(page.getByText('Fill in for the new shipment.')).toHaveCount(
      4,
    );

    // Every other field is pre-filled from the copied B/L
    await expect(page.getByLabel('Carrier code', {exact: true})).toHaveValue(
      'MSC',
    );
    await expect(page.getByLabel('Shipper', {exact: true})).toHaveValue(
      shipper.id,
    );
    await expect(page.getByLabel('Street', {exact: true})).toHaveValue(
      'Chemin Rieu',
    );
    await expect(page.getByLabel('City', {exact: true})).toHaveValue('Geneva');
    await expect(page.getByLabel('Country code', {exact: true})).toHaveValue(
      'CH',
    );
    await expect(page.getByLabel('Vessel', {exact: true})).toHaveValue(
      'MSC Gülsün',
    );
    await expect(page.getByLabel('Voyage', {exact: true})).toHaveValue('402E');
    await expect(page.getByLabel('Port of loading', {exact: true})).toHaveValue(
      'DKAAR',
    );
    await expect(
      page.getByLabel('Port of discharge', {exact: true}),
    ).toHaveValue('DEBRV');
    await expect(
      page.getByLabel('Planned departure', {exact: true}),
    ).toHaveValue('2023-12-20');
    await expect(page.getByLabel('Planned arrival', {exact: true})).toHaveValue(
      '2023-12-22',
    );
    await expect(page.getByLabel('Container type', {exact: true})).toHaveValue(
      '22G1',
    );
    await expect(page.getByLabel('Goods', {exact: true})).toHaveValue(
      'Shoes - black',
    );
    await expect(page.getByLabel('HS code', {exact: true})).toHaveValue(
      '640510',
    );
    await expect(
      page.getByLabel('Number of packages', {exact: true}),
    ).toHaveValue('400');
    await expect(
      page.getByLabel('Kind of packages', {exact: true}),
    ).toHaveValue('Fibreboard boxes');
    await expect(
      page.getByLabel('Gross weight (kg)', {exact: true}),
    ).toHaveValue('12000');

    await page.setViewportSize({width: 1440, height: 2350});
    await evidence(
      page,
      TICKET,
      'Create B/L form copied with shipment fields empty and marked',
    );
    await page.setViewportSize({width: 1440, height: 900});

    // Required empty shipment fields stop Save draft before hitting the server
    await page.getByRole('button', {name: 'Save draft'}).click();
    await expect(page.getByText('Fill in the B/L number.')).toBeVisible();
    await expect(
      page.getByText('Fill in the booking reference.'),
    ).toBeVisible();
    await expect(page.getByText('Fill in the container number.')).toBeVisible();

    // Reusing the original B/L number is rejected by the duplicate check
    await page.getByLabel('B/L number', {exact: true}).fill(accomplishedRef);
    await page
      .getByLabel('Booking reference', {exact: true})
      .fill('BKG-COPY-001');
    await page
      .getByLabel('Container number', {exact: true})
      .fill('MSKU9012345');
    await page.getByLabel('Seal number', {exact: true}).fill('SEAL-COPY-1');
    await expect(page.getByText('Fill in for the new shipment.')).toHaveCount(
      0,
    );
    await page.getByRole('button', {name: 'Save draft'}).click();
    await expect(page.getByRole('alert')).toContainText(
      `already has a B/L with the reference ${accomplishedRef}`,
    );

    // Filling a new B/L number saves an independent new draft
    await page.getByLabel('B/L number', {exact: true}).fill(copyRef);
    await page.getByRole('button', {name: 'Save draft'}).click();
    await expect(page).toHaveURL(/#\/bls\/[0-9a-f-]+$/);
    expect(page.url()).not.toContain(accomplishedId);
    await expect(
      page.getByRole('heading', {name: `B/L ${copyRef} (MSC)`}),
    ).toBeVisible();
    await expect(page.locator('dt:text-is("State") + dd')).toHaveText('Draft');
    await expect(page.getByRole('region', {name: 'Approval'})).toContainText(
      'Shoes - black',
    );
    await expect(
      page.getByText(
        'No steps yet: the chain of title starts when the B/L is issued.',
      ),
    ).toBeVisible();
    await dismissToasts(page);
    await page.setViewportSize({width: 1440, height: 1400});
    await evidence(
      page,
      TICKET,
      'Saved copy opens as an independent new draft B/L',
    );
    await page.setViewportSize({width: 1440, height: 900});
  });

  test('carrier sees Copy on drafts too; other organisations never see Copy and cannot copy via URL', async ({
    page,
  }) => {
    await page.setViewportSize({width: 1440, height: 900});
    await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
    await page.getByRole('link', {name: `Open ${draftLabel}`}).click();
    await expect(page.getByRole('heading', {name: draftLabel})).toBeVisible();
    await expect(
      page.getByRole('link', {name: 'Copy', exact: true}),
    ).toBeVisible();

    // Shipper sees no Copy button on the accomplished B/L
    await page.getByRole('button', {name: 'Sign out'}).click();
    await signInOnScreen(page, shipper.clerk.email, INVITED_PASSWORD);
    await page.getByRole('link', {name: `Open ${accomplishedLabel}`}).click();
    await expect(
      page.getByRole('heading', {name: accomplishedLabel}),
    ).toBeVisible();
    await expect(
      page.getByRole('link', {name: 'Copy', exact: true}),
    ).toHaveCount(0);

    // Another carrier-role organisation holding the B/L sees no Copy and gets 404 via ?copy=
    await page.getByRole('button', {name: 'Sign out'}).click();
    await signInOnScreen(page, otherCarrier.clerk.email, INVITED_PASSWORD);
    await page.getByRole('link', {name: `Open ${endorsedLabel}`}).click();
    await expect(
      page.getByRole('heading', {name: endorsedLabel}),
    ).toBeVisible();
    await expect(
      page.getByRole('link', {name: 'Copy', exact: true}),
    ).toHaveCount(0);
    await page.goto(`/#/bls/new?copy=${endorsedId}`);
    await expect(page.getByRole('alert')).toContainText('B/L not found');
  });
});

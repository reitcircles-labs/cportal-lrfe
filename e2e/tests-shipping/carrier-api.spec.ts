/**
 * Carrier issuance API (CB-56): the platform administrator creates an organisation API key for a
 * carrier on the organisation detail screen; the carrier's system exchanges it for a scoped access
 * token, issues a B/L through `POST /api/records/issuance`, is blocked on duplicate cargo, and the
 * issued B/L appears on screen just like a manually issued one. Revoking the key stops further
 * token exchanges immediately.
 */
import {expect, test} from '@playwright/test';
import {unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  TRADE_ROLE,
  demoEmails,
  dismissToasts,
  negotiableBl,
  organisationWithClerk,
  signIn,
  signInOnScreen,
} from '../support/shipping';
import {DEMO_PASSWORD, GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

test.describe('Carrier issuance API (CB-56)', () => {
  test.use({baseURL: SHIPPING_URL});

  test(
    'creates an API key, issues a B/L via the API (appearing on screen), blocks duplicate cargo, and revokes the key',
    {tag: '@CB-56'},
    async ({page, playwright}) => {
      test.setTimeout(240_000);
      const api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      try {
        const admin = await signIn(api, demoEmails('adm')[0]);
        const carrier = await organisationWithClerk(api, admin, 'Carrier');
        const shipper = await organisationWithClerk(
          api,
          admin,
          'Shipper',
          TRADE_ROLE,
        );

        await page.setViewportSize({width: 1440, height: 1000});
        await signInOnScreen(page, demoEmails('adm')[0], DEMO_PASSWORD);
        await page.goto(`/#/admin/organisations/${carrier.id}`);
        await expect(
          page.getByRole('heading', {name: carrier.name}),
        ).toBeVisible();

        const keysSection = page.getByRole('region', {
          name: 'Carrier API keys',
        });
        await keysSection.getByLabel('Key name').fill('Carrier TMS');
        await keysSection.getByLabel(/Allow direct B\/L issue/).check();
        await keysSection.getByRole('button', {name: 'Create API key'}).click();

        const secretBox = keysSection.getByRole('status');
        await expect(secretBox).toContainText('lrfe_');
        const secretText =
          (await secretBox.locator('.mono').textContent())?.trim() ?? '';
        expect(secretText).toMatch(/^lrfe_/);
        await dismissToasts(page);
        await keysSection.scrollIntoViewIfNeeded();
        await evidence(
          page,
          'CB-56',
          'Carrier API key created on organisation page',
        );

        // Exchange API key for an access token
        const tokenRes = await api.post('/api/auth/api-token', {
          headers: {'x-api-key': secretText},
        });
        expect(tokenRes.status()).toBe(200);
        const {accessToken} = await tokenRes.json();

        // Issue a B/L straight through via POST /api/records/issuance
        const ref = `CB56${unique().toUpperCase()}`.slice(0, 15);
        const doc = negotiableBl(ref) as Record<string, unknown>;
        const container = `CB56${unique().toUpperCase()}`.slice(0, 11);
        const seal = `SL${unique().toUpperCase()}`.slice(0, 10);
        const equipments = doc['utilizedTransportEquipments'] as Array<
          Record<string, unknown>
        >;
        equipments[0] = {
          ...equipments[0],
          equipment: {
            ...(equipments[0]['equipment'] as Record<string, unknown>),
            equipmentReference: container,
          },
          seals: [{number: seal, sourceCode: 'CAR'}],
        };
        const consignments = doc['consignmentItems'] as Array<
          Record<string, unknown>
        >;
        const cargoItems = consignments[0]['cargoItems'] as Array<
          Record<string, unknown>
        >;
        cargoItems[0] = {...cargoItems[0], equipmentReference: container};

        const issueRes = await api.post('/api/records/issuance', {
          headers: {authorization: `Bearer ${accessToken}`},
          data: {
            format: 'dcsa-3.0',
            document: doc,
            partyOrganisations: {shipper: shipper.id},
            issue: true,
          },
        });
        expect(issueRes.status(), await issueRes.text()).toBe(201);
        const issued = await issueRes.json();
        expect(issued.title.state).toBe('issued');
        expect(issued.cargoKey).toBeTruthy();

        // Duplicate container + seal is refused 409 duplicate-cargo
        const dupeDoc = {
          ...doc,
          transportDocumentReference: `${ref}D`.slice(0, 16),
        };
        const dupeRes = await api.post('/api/records/issuance', {
          headers: {authorization: `Bearer ${accessToken}`},
          data: {
            format: 'dcsa-3.0',
            document: dupeDoc,
            partyOrganisations: {shipper: shipper.id},
            issue: true,
          },
        });
        expect(dupeRes.status()).toBe(409);
        expect((await dupeRes.json()).details.code).toBe('duplicate-cargo');

        // Revoke the key on screen and verify token exchange now fails (401)
        await keysSection.getByRole('button', {name: 'Revoke'}).click();
        await page
          .getByRole('alertdialog')
          .getByRole('button', {name: 'Revoke', exact: true})
          .click();
        await expect(
          keysSection.getByRole('table', {name: 'API keys'}),
        ).toContainText('Revoked');

        const revokedRes = await api.post('/api/auth/api-token', {
          headers: {'x-api-key': secretText},
        });
        expect(revokedRes.status()).toBe(401);

        // Sign in as the carrier clerk and verify the API-issued B/L appears on screen
        await page.getByRole('button', {name: 'Sign out'}).click();
        await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
        await page
          .getByRole('link', {name: `Open ${issued.record.label}`, exact: true})
          .click();
        await expect(
          page.getByRole('heading', {name: issued.record.label}),
        ).toBeVisible();
        await expect(
          page.getByText('Issued', {exact: true}).first(),
        ).toBeVisible();
        await expect(page.getByText(shipper.name).first()).toBeVisible();
        await dismissToasts(page);
        await evidence(
          page,
          'CB-56',
          'B/L issued through carrier API shown on screen',
        );
      } finally {
        await api.dispose();
      }
    },
  );
});

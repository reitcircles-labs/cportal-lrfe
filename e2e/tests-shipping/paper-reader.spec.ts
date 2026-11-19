/**
 * Automatic paper B/L reading (CB-57): a carrier clerk uploads a scanned paper B/L on the New B/L
 * screen; the automatic check fills the draft fields, matches the shipper, highlights uncertain
 * values for confirmation, and lets the clerk confirm and save the draft.
 */
import {expect, test} from '@playwright/test';
import {unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  TRADE_ROLE,
  demoEmails,
  dismissToasts,
  organisationWithClerk,
  signIn,
  signInOnScreen,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

test.describe('Reading paper B/Ls automatically (CB-57)', () => {
  test.use({baseURL: SHIPPING_URL});

  test(
    'uploads a scanned paper B/L, highlights uncertain fields, and saves the confirmed draft',
    {tag: '@CB-57'},
    async ({page, playwright}) => {
      test.setTimeout(180_000);
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
        await signInOnScreen(page, carrier.clerk.email, INVITED_PASSWORD);
        await page.getByRole('link', {name: 'New B/L'}).click();
        await expect(
          page.getByRole('heading', {name: 'New B/L'}),
        ).toBeVisible();

        const ref = `PPR${unique().toUpperCase()}`.slice(0, 16);
        const scanPayload = JSON.stringify({
          reference: ref,
          carrierCode: 'MSC',
          bookingReference: `BKG-${ref}`,
          toOrder: true,
          shipperName: shipper.name,
          issuerStreet: 'Havnekaj 12',
          issuerCity: 'Aarhus',
          issuerCountry: 'DK',
          vesselName: 'MV Atlantic Crest',
          voyageNumber: '2611N',
          portOfLoading: 'DKAAR',
          portOfDischarge: 'NLRTM',
          departureDate: '2026-11-20',
          arrivalDate: '2026-11-24',
          containerNumber: 'MSKU7045123',
          isoEquipmentCode: '22G1',
          sealNumber: 'SL220871',
          goods: '640 bags green coffee',
          hsCode: '090111',
          packages: 640,
          packageDescription: 'Bags',
          grossWeightKg: 38400,
          termsAndConditions: "Shipper's load, stow and count.",
          uncertain: ['grossWeightKg'],
        });

        await page.locator('#paper-bl-file').setInputFiles({
          name: 'scanned-bl.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(scanPayload, 'utf8'),
        });
        await page.getByRole('button', {name: 'Read paper B/L'}).click();

        const paperRegion = page.getByRole('region', {
          name: 'Read from paper B/L',
        });
        await expect(paperRegion.getByRole('status')).toContainText(
          'scanned-bl.pdf',
        );
        await expect(page.getByLabel('B/L number')).toHaveValue(ref);
        await expect(page.getByLabel('Shipper')).toHaveValue(shipper.id);
        await expect(page.getByLabel(/Gross weight/)).toHaveValue('38400');
        await expect(page.getByText('Check value')).toHaveCount(1);
        await dismissToasts(page);
        await evidence(
          page,
          'CB-57',
          'Paper B/L upload pre-fills draft fields',
        );
        const grossWeight = page.getByLabel(/Gross weight/);
        await grossWeight.scrollIntoViewIfNeeded();
        await evidence(
          page,
          'CB-57',
          'Uncertain field highlighted for confirmation',
        );

        // Carrier clerk corrects/confirms the uncertain field -> highlight clears -> saves draft
        await page.getByLabel(/Gross weight/).fill('38040');
        await expect(page.getByText('Check value')).toHaveCount(0);
        await page.getByRole('button', {name: 'Save draft'}).click();

        await expect(
          page.getByRole('heading', {name: new RegExp(`B/L ${ref}`)}),
        ).toBeVisible();
        await expect(
          page.getByText('Draft', {exact: true}).first(),
        ).toBeVisible();
      } finally {
        await api.dispose();
      }
    },
  );
});

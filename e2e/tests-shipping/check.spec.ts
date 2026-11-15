/**
 * Checking a B/L on the shipping app's screens (CB-47, R1, good weather, from the CB-15 and CB-16
 * designs): a carrier issues a B/L to order to the shipper, which endorses it to its bank, both
 * through the API. The bank's clerk opens "Check this B/L" on the B/L's page: each step of the
 * chain of title is checked in the browser against the platform's signature, and the latest step's
 * proof on the blockchain is pending. Once the administrator anchors the test chain, the check says
 * confirmed; the clerk downloads the proof, and the offline verifier (the audit service's
 * lrfe-verify.mjs, imported as title-blank-endorsement.spec.ts does, its blockchain queries sent
 * to the test chain) finds the downloaded file valid with the wallet and the key fingerprint the
 * page shows. On the home, "Check a B/L by number" finds the B/L for the bank and opens it; for an
 * organisation that is not party to it, it says not found. Screenshots for the ticket with
 * `npm run evidence -- CB-47 --shipping` (support/evidence.ts).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
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
  demoEmails,
  TRADE_ROLE,
  organisationWithClerk,
  serviceToken,
  signIn,
  signInOnScreen,
  type Organisation,
  type SignedIn,
} from '../support/shipping';
import {GATEWAY_URL, REPO_DIR, SHIPPING_URL} from '../stack/config.mjs';

/** The ticket the screenshots are for. */
const TICKET = 'CB-47';

/** What the check says of a chain of two steps, each checked. */
const ALL_CHECKED =
  "Both steps carry the platform's signature, checked in your browser.";

/** What the box on the home says when no B/L is found. */
const NOT_FOUND =
  'No B/L found with that number. It does not exist, or your organisation is not party to it.';

/** A title proof bundle (lrfe-title-proof/1), as far as this test reads it. */
interface TitleProof {
  format: string;
  recordNo: string;
  entries: Array<{seq: number; command: string}>;
  anchor: {pending?: boolean; status?: string};
}

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
 * The verifier's blockchain queries, sent to the test chain behind the gateway instead: the
 * query's name (the last part of its path) is kept, the host is the gateway's.
 * @param url the address the verifier asks
 * @param init the request's options
 * @return the test chain's answer
 */
function testChainFetch(url: string, init: RequestInit): Promise<Response> {
  const query = new URL(url).pathname.split('/').pop();
  return fetch(`${GATEWAY_URL}/api/audit/test/koios/${query}`, init);
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
  'checking a B/L and its proof on the screens (CB-47)',
  {tag: '@CB-47'},
  () => {
    let api: APIRequestContext;
    let admin: SignedIn;
    let bank: Organisation;
    let stranger: Organisation;
    let bl: {id: string; label: string; recordNo: string};

    /**
     * Opens the B/L's page from the home, as the bank's clerk.
     * @param page the page
     */
    async function openAsBank(page: Page): Promise<void> {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, bank.clerk.email, INVITED_PASSWORD);
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await page.getByRole('link', {name: `Open ${bl.label}`}).click();
      await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
    }

    /**
     * The B/L's proof file as the bank reads it through the API.
     * @return the bundle
     */
    async function proofOf(): Promise<TitleProof> {
      const res = await api.get(`/api/records/${bl.id}/title/proof`, {
        headers: bank.clerk.headers,
      });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    }

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(240_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      admin = await signIn(api, demoEmails('adm')[0]);
      const carrier = await organisationWithClerk(api, admin, 'Carrier');
      const shipper = await organisationWithClerk(
        api,
        admin,
        'Shipper',
        TRADE_ROLE,
      );
      bank = await organisationWithClerk(api, admin, 'Bank', TRADE_ROLE);
      stranger = await organisationWithClerk(
        api,
        admin,
        'Stranger',
        TRADE_ROLE,
      );

      const created = await api.post('/api/records', {
        headers: carrier.clerk.headers,
        data: {
          format: 'dcsa-3.0',
          document: negotiableBl(`CB47${unique().toUpperCase()}`.slice(0, 20)),
          partyOrganisations: {shipper: shipper.id},
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      const record = await created.json();
      bl = {id: record.id, label: record.label, recordNo: record.recordNo};
      const submitted = await api.post(
        `/api/records/${bl.id}/versions/1/submit`,
        {headers: carrier.clerk.headers},
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
        headers: carrier.clerk.headers,
        data: {},
      });
      expect(issued.status(), await issued.text()).toBe(200);
      const endorsed = await api.post(`/api/records/${bl.id}/title/endorse`, {
        headers: shipper.clerk.headers,
        data: {to: bank.id, inBlank: false},
      });
      expect(endorsed.status(), await endorsed.text()).toBe(200);
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test("the bank's clerk checks the B/L: each step's signature checked, the proof pending", async ({
      page,
    }) => {
      // nothing is anchored yet for this B/L's latest step
      expect((await proofOf()).anchor).toEqual({pending: true});
      await openAsBank(page);
      const panel = page.getByRole('region', {name: 'Check this B/L'});
      await expect(panel).toBeVisible();
      await expect(
        panel.getByRole('button', {name: 'Download the proof'}),
      ).toHaveCount(0);
      await panel.getByRole('button', {name: 'Check this B/L'}).click();

      await expect(panel.getByRole('status').first()).toHaveText(ALL_CHECKED);
      // the results per step; the chain itself is the table above
      const steps = panel.getByRole('list', {name: 'Steps checked'});
      await expect(steps.getByRole('listitem')).toHaveText([
        'Step 1, Issued: Signature checked',
        'Step 2, Endorsed: Signature checked',
      ]);
      await expect(panel).toContainText(
        'Signed with the keys this platform publishes (fingerprint',
      );
      await expect(panel).toContainText(
        'Proof on the blockchain: The platform reports: pending, not on the blockchain yet.',
      );
      await expect(
        panel.getByRole('heading', {name: 'How to verify it offline'}),
      ).toBeVisible();
      await expect(
        panel.getByRole('link', {name: 'Download the verifier'}),
      ).toHaveAttribute('href', '/api/audit/verifier/lrfe-verify.mjs');
      await dismissToasts(page);
      await page.setViewportSize({width: 1440, height: 1700});
      await evidence(
        page,
        TICKET,
        "The bank checks the B/L: both steps' signatures checked, the proof pending",
      );
    });

    test('once anchored the proof is confirmed; the downloaded proof verifies offline', async ({
      page,
    }) => {
      test.setTimeout(180_000);
      // the B/L's two title events on the audit trail, then the batch on the test chain
      const titleEvents = async () => {
        const res = await api.get(`/api/audit/trail?subject=record:${bl.id}`, {
          headers: admin.headers,
        });
        expect(res.status(), await res.text()).toBe(200);
        const {entries} = await res.json();
        return entries
          .filter((e: {type: string}) => e.type.startsWith('records.title.'))
          .map((e: {type: string}) => e.type);
      };
      await expect
        .poll(titleEvents, {timeout: 30_000})
        .toEqual(['records.title.issue', 'records.title.endorse']);
      // the test stack has no blockchain: the administrator makes the batch on the test chain
      const batch = await api.post('/api/audit/test/anchorings', {
        headers: admin.headers,
        data: {outcome: 'confirmed'},
      });
      expect(batch.status(), await batch.text()).toBe(201);
      await expect
        .poll(async () => (await proofOf()).anchor.status, {timeout: 30_000})
        .toBe('confirmed');

      await openAsBank(page);
      const panel = page.getByRole('region', {name: 'Check this B/L'});
      await panel.getByRole('button', {name: 'Check this B/L'}).click();
      await expect(panel.getByRole('status').first()).toHaveText(ALL_CHECKED);
      await expect(panel).toContainText(
        'Proof on the blockchain: The platform reports: confirmed on the blockchain on ',
      );

      // the command names the platform's published wallet and key fingerprint
      const wallet = await (
        await fetch(`${GATEWAY_URL}/api/audit/anchoring/wallet`)
      ).json();
      expect(
        wallet.address,
        'the test chain has an anchoring wallet',
      ).toBeTruthy();
      const verifier = join(
        REPO_DIR,
        'backend',
        'services',
        'audit',
        'verifier',
        'lrfe-verify.mjs',
      );
      const {verifyTitleProof, titleKeyFingerprint} = await import(
        pathToFileURL(verifier).href
      );
      const keys = await (
        await fetch(`${GATEWAY_URL}/api/records/title/keys`)
      ).json();
      const fingerprint: string = titleKeyFingerprint(keys);
      const fileName = `title-proof-${bl.recordNo}.json`;
      await expect(panel.locator('code')).toHaveText(
        `node lrfe-verify.mjs ${fileName} --address ${wallet.address} --title-key ${fingerprint}`,
      );
      await expect(panel).toContainText(
        `Signed with the keys this platform publishes (fingerprint ${fingerprint}). For an independent check, compare this fingerprint with one you received another way, for example from the carrier.`,
      );
      await dismissToasts(page);
      await page.setViewportSize({width: 1440, height: 1700});
      await evidence(
        page,
        TICKET,
        'Confirmed on the blockchain, with how to verify the proof offline',
      );

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        panel.getByRole('button', {name: 'Download the proof'}).click(),
      ]);
      expect(download.suggestedFilename()).toBe(fileName);
      const saved = test.info().outputPath(fileName);
      await download.saveAs(saved);
      const bundle = JSON.parse(readFileSync(saved, 'utf8'));
      expect(bundle.format).toBe('lrfe-title-proof/1');
      expect(bundle.recordNo).toBe(bl.recordNo);
      expect(bundle.entries.map((e: {command: string}) => e.command)).toEqual([
        'issue',
        'endorse',
      ]);

      const result = await verifyTitleProof(bundle, {
        address: wallet.address,
        titleKey: fingerprint,
        fetchImpl: testChainFetch,
      });
      expect(result.valid, JSON.stringify(result.checks)).toBe(true);
      expect(result.title).toMatchObject({seq: 2, holder: bank.id});
    });

    test('"Check a B/L by number" on the home finds the B/L and opens it', async ({
      page,
    }) => {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, bank.clerk.email, INVITED_PASSWORD);
      const box = page.getByRole('region', {name: 'Check a B/L by number'});
      await expect(box).toBeVisible();
      // typed in lower case, with spaces around it
      await box
        .getByLabel('B/L number')
        .fill(`  ${bl.recordNo.toLowerCase()} `);
      await dismissToasts(page);
      await evidence(page, TICKET, 'The bank looks up the B/L by its number');
      await box.getByRole('button', {name: 'Check'}).click();
      await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#/bls/${bl.id}$`));
      await expect(
        page.getByRole('region', {name: 'Check this B/L'}),
      ).toBeVisible();
    });

    test('an organisation that is not party to the B/L does not find it', async ({
      page,
    }) => {
      const res = await api.get(
        `/api/records/title?number=${encodeURIComponent(bl.recordNo)}`,
        {headers: stranger.clerk.headers},
      );
      expect(res.status(), await res.text()).toBe(200);
      expect((await res.json()).items).toEqual([]);
      const direct = await api.get(`/api/records/${bl.id}/title/proof`, {
        headers: stranger.clerk.headers,
      });
      expect(direct.status()).toBe(404);

      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, stranger.clerk.email, INVITED_PASSWORD);
      const box = page.getByRole('region', {name: 'Check a B/L by number'});
      await box.getByLabel('B/L number').fill(bl.recordNo);
      await box.getByRole('button', {name: 'Check'}).click();
      await expect(box.getByRole('status')).toHaveText(NOT_FOUND);
      await expect(page).not.toHaveURL(/#\/bls\//);
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'Another organisation: not found, without saying whether it exists',
      );
    });
  },
);

/**
 * The R1 demo's storyline on a fresh shipping stack (CB-48, demo/SHIPPING-STORYLINE.md): only the
 * seeded demo users (the shipping pack's identity section), only the screens, each act as the
 * storyline has it. The administrator finds the five organisations of the demo; the carrier's
 * clerk drafts a negotiable B/L to the shipper and submits it, and cannot approve it herself
 * (four eyes); the carrier's release manager approves it and issues it to the shipper; the
 * shipper endorses it to its bank, which endorses it to the buyer's bank, which endorses it to the
 * buyer: one holder at a time, each step on the chain of title; the buyer surrenders it and the
 * carrier releases the goods. The buyer's bank then checks the B/L and downloads its proof, which
 * the offline verifier finds valid. Each person sets up their authenticator on the screen at their
 * first sign-in, as on a fresh demo install.
 *
 * The one step not on the screens: the test stack has no blockchain, so the administrator makes the
 * anchoring batch on the test chain through the API, as check.spec.ts does; on the demo install the
 * audit service anchors by itself every ANCHOR_PERIOD. Screenshots of the key moments with
 * `npm run evidence -- CB-48 --shipping` (support/evidence.ts).
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
import {identity} from '../../backend/domains/shipping/src/identity.js';
import {codeFor, readSecrets, saveSecrets} from '../support/auth';
import {evidence} from '../support/evidence';
import {dismissToasts, signIn, testChainFetch} from '../support/shipping';
import {
  DEMO_PASSWORD,
  GATEWAY_URL,
  REPO_DIR,
  SHIPPING_URL,
} from '../stack/config.mjs';

/** The ticket the screenshots are for. */
const TICKET = 'CB-48';

/** A demo user of the shipping pack, as far as the storyline reads it. */
interface DemoUser {
  name: string;
  email: string;
  organisation?: string;
  roles: string[];
}

/** A demo organisation of the shipping pack. */
interface DemoOrganisation {
  code: string;
  name: string;
}

/** The pack's demo data (its JSDoc type is not read here). */
const DEMO = identity as {
  demoUsers: DemoUser[];
  demoOrganisations: DemoOrganisation[];
};

/** The five organisations of the journey, in the order the B/L travels. */
const [CARRIER, SHIPPER, EXPORTER_BANK, BUYER_BANK, BUYER] =
  DEMO.demoOrganisations;

/**
 * The demo users of an organisation, in the pack's order.
 * @param organisation the organisation
 * @return its demo users
 */
function peopleOf(organisation: DemoOrganisation): DemoUser[] {
  return DEMO.demoUsers.filter(u => u.organisation === organisation.code);
}

/** The cast of the storyline. */
const ADMIN = DEMO.demoUsers.find(u => u.roles.includes('adm')) as DemoUser;
const [CLERK, APPROVER] = peopleOf(CARRIER);
const [EXPORTER] = peopleOf(SHIPPER);
const [EXPORTER_BANKER] = peopleOf(EXPORTER_BANK);
const [BUYER_BANKER] = peopleOf(BUYER_BANK);
const [IMPORTER] = peopleOf(BUYER);

/** The platform operator's own organisation, which is never offered (CB-48). */
const OPERATOR_NAME = (identity as {defaultOrganisation: {name: string}})
  .defaultOrganisation.name;

/** The carrier's SMDG code on the B/L (set on Bluewater in Act 1, pre-filled in Act 2). */
const CARRIER_CODE = 'MSC';

/** What the check says of the whole journey: six steps, each signed. */
const ALL_CHECKED =
  "All 6 steps carry the platform's signature, checked in your browser.";

/**
 * Signs a demo user in on the screen with the demo password, as the storyline does: at their first
 * sign-in they set up the authenticator from the setup key the screen shows (its secret is kept
 * for later sign-ins and the API), afterwards they enter the code.
 * @param page the page, on the shipping app
 * @param user the demo user
 * @param shot a caption for a screenshot of the authenticator step, if one is wanted
 */
async function signInAs(
  page: Page,
  user: DemoUser,
  shot?: string,
): Promise<void> {
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  const heading = page.getByRole('heading', {
    name: /^(Set up your authenticator|Enter your code)$/,
  });
  await expect(heading).toBeVisible();
  let secret: string;
  if ((await heading.textContent())?.trim() === 'Set up your authenticator') {
    await page.getByText("Can't scan? Type the setup key instead").click();
    secret = ((await page.locator('code.key').textContent()) ?? '').replace(
      /\s/g,
      '',
    );
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    saveSecrets({...readSecrets(), [user.email]: secret});
  } else {
    secret = readSecrets()[user.email];
    expect(secret, `the authenticator secret of ${user.email}`).toBeTruthy();
  }
  if (shot) {
    await evidence(page, TICKET, shot);
  }
  await page.getByLabel('6-digit code').fill(codeFor(secret));
  await page.getByRole('button', {name: 'Verify and sign in'}).click();
  await expect(page.getByRole('button', {name: 'Sign out'})).toBeVisible();
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'the R1 demo storyline with the seeded demo users (CB-48)',
  {tag: '@CB-48'},
  () => {
    // the carrier's form, as in the storyline: its code, the year and month, a running number
    // (here from the clock, so a rerun finds its own); 14 characters, within DCSA's 20
    const reference = `${CARRIER.code}2611${String(Date.now()).slice(-6)}`;
    const label = `B/L ${reference} (${CARRIER_CODE})`;
    let blId = '';

    /**
     * Opens the B/L's page from the signed-in user's home.
     * @param page the page, signed in
     */
    async function openBl(page: Page): Promise<void> {
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await page.getByRole('link', {name: `Open ${label}`}).click();
      await expect(page.getByRole('heading', {name: label})).toBeVisible();
    }

    /**
     * Checks the B/L's page: its state, its one holder, the organisation's role and the chain's
     * last step.
     * @param page the page, on the B/L
     * @param want what the page shows
     * @param want.state the B/L's state
     * @param want.holder the holder's name
     * @param want.role the signed-in organisation's role
     * @param want.steps the chain's steps
     * @param want.last the last step's name
     */
    async function expectBl(
      page: Page,
      want: {
        state: string;
        holder: string;
        role: string;
        steps: number;
        last: string;
      },
    ): Promise<void> {
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        want.state,
      );
      await expect(page.locator('dt:text-is("Holder") + dd')).toContainText(
        want.holder,
      );
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        want.role,
      );
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(want.steps);
      await expect(chain.locator('tbody tr').last()).toContainText(want.last);
    }

    /**
     * The holder's clerk endorses the B/L on the screen to the next organisation, confirms, and
     * sees the new holder: one holder at a time, the endorser now a past holder without actions.
     * @param page the page
     * @param from the holder's demo user
     * @param fromOrganisation the holder
     * @param to the organisation it is endorsed to
     * @param steps the chain's steps once endorsed
     */
    async function endorse(
      page: Page,
      from: DemoUser,
      fromOrganisation: DemoOrganisation,
      to: DemoOrganisation,
      steps: number,
    ): Promise<void> {
      await signInAs(page, from);
      await openBl(page);
      await expect(page.locator('dt:text-is("Holder") + dd')).toContainText(
        fromOrganisation.name,
      );
      await page.getByRole('button', {name: 'Endorse to…'}).click();
      const panel = page.getByRole('region', {name: 'Endorse', exact: true});
      const picker = panel.getByRole('radiogroup', {name: 'Endorse to'});
      await expect(picker).toHaveAccessibleDescription(
        'Organisations registered on the platform.',
      );
      // never its own organisation, nor the platform operator's (CB-48)
      await expect(
        picker.getByRole('radio', {name: fromOrganisation.name}),
      ).toHaveCount(0);
      await expect(
        picker.getByRole('radio', {name: OPERATOR_NAME}),
      ).toHaveCount(0);
      await picker.getByRole('radio', {name: to.name}).check();
      // what happens, under the choice and again in the confirmation
      const outcome = `${to.name} becomes the holder; you can no longer act on this B/L.`;
      await expect(panel.getByRole('status')).toHaveText(outcome);
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        `${fromOrganisation.name} picks ${to.name} to endorse to`,
      );
      await panel.getByRole('button', {name: 'Endorse', exact: true}).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Endorse ${label} to ${to.name}?`);
      await expect(dialog).toContainText(outcome);
      if (steps === 2) {
        await evidence(
          page,
          TICKET,
          'The endorsement, confirmed before it is done',
        );
      }
      await dialog.getByRole('button', {name: 'Endorse', exact: true}).click();

      await expectBl(page, {
        state: 'With holder',
        holder: to.name,
        role: 'Past holder',
        steps,
        last: 'Endorsed',
      });
      await expect(page.getByRole('button', {name: 'Endorse to…'})).toHaveCount(
        0,
      );
      await dismissToasts(page);
      await evidence(page, TICKET, `Endorsed: ${to.name} holds the B/L`);
    }

    test('Act 1: the administrator finds the five organisations of the demo', async ({
      page,
    }) => {
      await signInAs(
        page,
        ADMIN,
        'First sign-in: each person sets up the authenticator',
      );
      // the administrator, who reads no B/Ls, lands on the organisations
      await expect(
        page.getByRole('heading', {name: 'Organisations', level: 1}),
      ).toBeVisible();
      for (const organisation of DEMO.demoOrganisations) {
        await expect(
          page.locator('tbody tr', {hasText: organisation.name}),
        ).toContainText(organisation.code);
      }
      await dismissToasts(page);
      await evidence(page, TICKET, 'The five organisations of the demo');

      // Act 1 (CB-68): set Bluewater Meridian Lines' default SMDG carrier code
      await page.getByRole('link', {name: `Open ${CARRIER.name}`}).click();
      await expect(
        page.getByRole('heading', {name: CARRIER.name, level: 1}),
      ).toBeVisible();
      await page
        .getByLabel('Default carrier code', {exact: true})
        .selectOption(CARRIER_CODE);
      await page.getByRole('button', {name: 'Save carrier code'}).click();
      await expect(page.getByText(`SMDG ${CARRIER_CODE}`)).toBeVisible();
    });

    test("Act 2: the carrier's clerk drafts the B/L and submits it; she cannot approve it", async ({
      page,
    }) => {
      await signInAs(page, CLERK);
      await expect(
        page.getByRole('heading', {name: 'Bills of lading'}),
      ).toBeVisible();
      await page.getByRole('link', {name: 'New B/L'}).click();
      await expect(page.getByRole('heading', {name: 'New B/L'})).toBeVisible();
      // the default SMDG carrier code set in Act 1 is already selected
      await expect(page.getByLabel('Carrier code', {exact: true})).toHaveValue(
        CARRIER_CODE,
      );
      const fields: Array<[string, string]> = [
        ['B/L number', reference],
        ['Booking reference', 'BKG-2611-0042'],
        ['Street', 'Rua do Porto 12'],
        ['City', 'Santos'],
        ['Country code', 'BR'],
        ['Vessel', 'Meridian Star'],
        ['Voyage', '2611E'],
        ['Port of loading', 'BRSSZ'],
        ['Port of discharge', 'NLRTM'],
        ['Planned departure', '2026-11-20'],
        ['Planned arrival', '2026-12-08'],
        ['Container number', 'BWMU7045123'],
        ['Container type', '22G1'],
        ['Seal number', 'SL220871'],
        ['Goods', '320 bags of green coffee beans'],
        ['HS code', '090111'],
        ['Number of packages', '320'],
        ['Kind of packages', 'Bags'],
        ['Gross weight (kg)', '19200'],
      ];
      for (const [field, value] of fields) {
        await page.getByLabel(field, {exact: true}).fill(value);
      }
      const shipperPicker = page.getByLabel('Shipper', {exact: true});
      // the platform operator's own organisation is never offered (CB-48)
      await expect(
        shipperPicker.getByRole('option', {name: OPERATOR_NAME}),
      ).toHaveCount(0);
      await shipperPicker.selectOption({label: SHIPPER.name});
      // the carrier's terms come filled in
      await expect(page.getByLabel("The carrier's terms")).not.toHaveValue('');
      await page.setViewportSize({width: 1440, height: 2300});
      await evidence(page, TICKET, "The carrier's clerk drafts the B/L");
      await page.setViewportSize({width: 1440, height: 900});

      await page.getByRole('button', {name: 'Save draft'}).click();
      await expect(page).toHaveURL(/#\/bls\/[0-9a-f-]{36}$/);
      blId = page.url().split('/').at(-1) ?? '';
      await expect(page.getByRole('heading', {name: label})).toBeVisible();
      await expect(page.locator('dt:text-is("Kind") + dd').first()).toHaveText(
        'Negotiable B/L',
      );
      await page.getByRole('button', {name: 'Submit for approval'}).click();
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'In review',
      );
      // four eyes: the person who drafted it cannot approve it
      await expect(page.getByRole('region', {name: 'Approval'})).toContainText(
        'You prepared this draft, so a second person must approve it.',
      );
      await expect(page.getByRole('button', {name: 'Approve'})).toHaveCount(0);
      await dismissToasts(page);
      await evidence(page, TICKET, 'Submitted: a second person must approve');
    });

    test("Act 3: the carrier's release manager approves it and issues it to the shipper", async ({
      page,
    }) => {
      expect(blId).not.toBe('');
      await signInAs(page, APPROVER);
      await openBl(page);
      const approval = page.getByRole('region', {name: 'Approval'});
      await expect(approval).toContainText('Waiting for your approval');
      await expect(approval).toContainText(CLERK.name);
      await page.getByRole('button', {name: 'Approve'}).click();
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Ready to issue',
      );
      await page.getByRole('button', {name: 'Issue to the shipper'}).click();
      await expectBl(page, {
        state: 'Issued',
        holder: SHIPPER.name,
        role: 'Carrier',
        steps: 1,
        last: 'Issued',
      });
      await dismissToasts(page);
      await evidence(page, TICKET, 'Issued: the shipper holds the B/L');
    });

    test('Act 4: the shipper endorses it to its bank', async ({page}) => {
      await endorse(page, EXPORTER, SHIPPER, EXPORTER_BANK, 2);
    });

    test("Act 5: the exporter's bank endorses it to the buyer's bank", async ({
      page,
    }) => {
      await endorse(page, EXPORTER_BANKER, EXPORTER_BANK, BUYER_BANK, 3);
    });

    test("Act 6: the buyer's bank endorses it to the buyer", async ({page}) => {
      await endorse(page, BUYER_BANKER, BUYER_BANK, BUYER, 4);
    });

    test('Act 7: the buyer surrenders it to the carrier', async ({page}) => {
      await signInAs(page, IMPORTER);
      await openBl(page);
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        'Holder',
      );
      await page
        .getByRole('button', {name: 'Surrender to the carrier'})
        .click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Surrender ${label} to the carrier?`);
      await evidence(page, TICKET, 'The buyer confirms the surrender');
      await dialog
        .getByRole('button', {name: 'Surrender', exact: true})
        .click();
      await expectBl(page, {
        state: 'Surrendered',
        holder: CARRIER.name,
        role: 'Past holder',
        steps: 5,
        last: 'Surrendered',
      });
      await dismissToasts(page);
      await evidence(page, TICKET, 'Surrendered: the carrier holds the B/L');
    });

    test('Act 8: the carrier releases the goods: the B/L is accomplished', async ({
      page,
    }) => {
      await signInAs(page, APPROVER);
      await openBl(page);
      await page.getByRole('button', {name: 'Release the goods'}).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Release the goods of ${label}?`);
      await dialog.getByRole('button', {name: 'Release', exact: true}).click();
      await expect(page.locator('dt:text-is("State") + dd')).toContainText(
        'Accomplished',
      );
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(6);
      await expect(chain.locator('tbody tr').last()).toContainText('Released');
      await expect(
        page.getByRole('region', {name: 'Actions'}).getByRole('button'),
      ).toHaveCount(0);
      await dismissToasts(page);
      await page.setViewportSize({width: 1440, height: 1500});
      await evidence(page, TICKET, 'Accomplished: the whole chain of title');
    });

    test("Act 9: the buyer's bank checks the B/L and its proof verifies offline", async ({
      page,
      playwright,
    }) => {
      test.setTimeout(180_000);
      const api: APIRequestContext = await playwright.request.newContext({
        baseURL: GATEWAY_URL,
      });
      try {
        const admin = await signIn(api, ADMIN.email);
        const banker = await signIn(api, BUYER_BANKER.email);
        // the six title events on the audit trail, then the batch on the test chain (the demo
        // install anchors by itself)
        const titleEvents = async () => {
          const res = await api.get(`/api/audit/trail?subject=record:${blId}`, {
            headers: admin.headers,
          });
          expect(res.status(), await res.text()).toBe(200);
          const {entries} = await res.json();
          return entries.filter((e: {type: string}) =>
            e.type.startsWith('records.title.'),
          ).length;
        };
        await expect.poll(titleEvents, {timeout: 30_000}).toBe(6);
        const batch = await api.post('/api/audit/test/anchorings', {
          headers: admin.headers,
          data: {outcome: 'confirmed'},
        });
        expect(batch.status(), await batch.text()).toBe(201);
        const anchorStatus = async () => {
          const res = await api.get(`/api/records/${blId}/title/proof`, {
            headers: banker.headers,
          });
          expect(res.status(), await res.text()).toBe(200);
          return (await res.json()).anchor.status;
        };
        await expect.poll(anchorStatus, {timeout: 30_000}).toBe('confirmed');

        await signInAs(page, BUYER_BANKER);
        await openBl(page);
        const panel = page.getByRole('region', {name: 'Check this B/L'});
        await panel.getByRole('button', {name: 'Check this B/L'}).click();
        await expect(panel.getByRole('status').first()).toHaveText(ALL_CHECKED);
        await expect(panel).toContainText(
          'Proof on the blockchain: The platform reports: confirmed on the blockchain on ',
        );
        await dismissToasts(page);
        await page.setViewportSize({width: 1440, height: 1900});
        await evidence(
          page,
          TICKET,
          "The buyer's bank checks the B/L: every step signed, confirmed on the blockchain",
        );

        const [download] = await Promise.all([
          page.waitForEvent('download'),
          panel.getByRole('button', {name: 'Download the proof'}).click(),
        ]);
        const saved = test.info().outputPath(download.suggestedFilename());
        await download.saveAs(saved);
        const bundle = JSON.parse(readFileSync(saved, 'utf8'));
        expect(bundle.entries.map((e: {command: string}) => e.command)).toEqual(
          ['issue', 'endorse', 'endorse', 'endorse', 'surrender', 'release'],
        );

        // the offline verifier, with the platform's published wallet and key fingerprint
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
        const wallet = await (
          await fetch(`${GATEWAY_URL}/api/audit/anchoring/wallet`)
        ).json();
        const keys = await (
          await fetch(`${GATEWAY_URL}/api/records/title/keys`)
        ).json();
        const result = await verifyTitleProof(bundle, {
          address: wallet.address,
          titleKey: titleKeyFingerprint(keys),
          fetchImpl: testChainFetch,
        });
        expect(result.valid, JSON.stringify(result.checks)).toBe(true);
        expect(result.title).toMatchObject({seq: 6});
      } finally {
        await api.dispose();
      }
    });
  },
);

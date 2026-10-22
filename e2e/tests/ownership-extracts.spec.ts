/**
 * Ownership extracts at the counter (API-692, designed in API-690): the Extracts tab of an approved
 * land record says whether an extract can be issued (its current version confirmed on the
 * blockchain); the records officer issues one for a registered owner whose identity document they
 * checked, downloads it, and revokes it with a reason. The registrar, who may not issue extracts,
 * has no such tab.
 *
 * The record is the canned AI's deed under a fresh number, for an erf of this run in Olympia: its
 * owners are Petrus and Maria Nghishidi, half each. The test blockchain has no anchoring job: the
 * test makes the confirmed batch (POST /api/audit/test/anchorings, as land-record.spec.ts does).
 */
import {expect, test, type Page} from '@playwright/test';
import {userByRole} from '../support/catalogue';
import {signInAs} from '../support/auth';
import {adminApi} from '../support/admin';
import {evidence} from '../support/evidence';
import {fileNumbered} from '../support/samples';
import {toast} from '../support/documents';
import {committedRecord} from '../support/records';
import {apiAs} from '../support/intake';

const rnd = (from: number, span: number) =>
  from + Math.floor(Math.random() * span);
/** An erf of this run, so reruns on one database start afresh. */
const ERF = rnd(40000, 9000);
const DEED = `T ${rnd(10000, 89999)}/2026`;
const LABEL = `Erf ${ERF}, Olympia`;

let recordId = '';

/** The record opened on its Extracts tab, as `role`. */
async function openExtracts(page: Page, role: 'rec' | 'sup') {
  await page.setViewportSize({width: 1600, height: 1000});
  await signInAs(page, userByRole(role).email, `/link?record=${recordId}`);
  await expect(page.locator('header.panel.head')).toContainText(LABEL);
}

test.describe.serial('Ownership extracts at the counter (API-692)', () => {
  test.beforeAll(async ({playwright, baseURL}) => {
    test.setTimeout(240_000);
    await fileNumbered(playwright, baseURL!, DEED, {
      property: `ERF NO. ${ERF} OLYMPIA`,
    });
    const record = await committedRecord(playwright, baseURL!, DEED, {
      kind: 'erf',
      number: String(ERF),
      township: 'Olympia',
      regDiv: 'K',
    });
    recordId = record.id;
  });

  test(
    'not on the blockchain yet: the tab says so and nothing can be issued',
    {tag: ['@API-692']},
    async ({page}) => {
      await openExtracts(page, 'rec');
      await page.getByRole('tab', {name: /^Extracts/}).click();
      const panel = page.locator('section.panel', {
        hasText: 'Ownership extracts',
      });
      await expect(panel).toContainText('Waiting for next batch');
      await expect(panel).toContainText(
        'Version 1 is not on the blockchain yet.',
      );
      await expect(
        panel.getByRole('button', {name: 'Issue extract'}),
      ).toBeDisabled();
      await expect(panel).toContainText(
        'No extracts issued for this record yet.',
      );
      await evidence(
        page,
        'API-692',
        'Extracts tab: version 1 is not on the blockchain yet, so no extract can be issued',
      );
    },
  );

  test(
    'on the blockchain: an extract is issued to an owner whose ID was checked, downloaded, and revoked with a reason',
    {tag: ['@API-692']},
    async ({page, playwright, baseURL}) => {
      test.slow();
      // the version goes on the blockchain: batches until its status is confirmed
      const admin = await adminApi(playwright, baseURL!);
      const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
      await expect
        .poll(
          async () => {
            const made = await admin.api.post('/api/audit/test/anchorings', {
              headers: admin.headers,
              data: {outcome: 'confirmed'},
            });
            expect(made.status(), await made.text()).toBe(201);
            const history = await (
              await rec.api.get(`/api/records/${recordId}/history`, {
                headers: rec.headers,
              })
            ).json();
            return history.versions[0]?.anchoring?.status;
          },
          {timeout: 30_000, intervals: [1000, 2000, 3000]},
        )
        .toBe('confirmed');
      await admin.dispose();
      await rec.dispose();

      await openExtracts(page, 'rec');
      await page.getByRole('tab', {name: /^Extracts/}).click();
      const panel = page.locator('section.panel', {
        hasText: 'Ownership extracts',
      });
      await expect(panel).toContainText('On the blockchain');
      await expect(panel).toContainText('Version 1 is current, in batch');
      const issueButton = panel.getByRole('button', {name: 'Issue extract'});
      await expect(issueButton).toBeEnabled();
      await evidence(
        page,
        'API-692',
        'Extracts tab: version 1 is on the blockchain, an extract can be issued',
      );

      // the issue dialog: the owner, the ID number checked against the record, the document seen
      await issueButton.click();
      const dialog = page.locator('form.dialog', {
        hasText: 'Issue an ownership extract',
      });
      await expect(dialog).toContainText(
        `For ${LABEL}. Only a registered owner can be given one`,
      );
      await dialog.getByLabel(/Petrus Nghishidi/).check();
      const id = dialog.getByLabel('ID number on their identity document');
      const confirm = dialog.getByRole('button', {name: 'Issue extract'});
      await id.fill('72110800399');
      await expect(dialog.locator('#idno-help')).toContainText(
        "Doesn't match the ID number on the record for Petrus Nghishidi.",
      );
      await expect(confirm).toBeDisabled();
      await id.fill('72110800345');
      await expect(dialog.locator('#idno-help')).toContainText(
        '✓ Matches the ID number on the record for Petrus Nghishidi.',
      );
      await expect(confirm).toBeDisabled();
      await dialog
        .getByLabel(/I have seen the owner's identity document/)
        .check();
      await expect(confirm).toBeEnabled();
      await expect(dialog).toContainText(
        'Version 1, the current one · committed',
      );
      await evidence(
        page,
        'API-692',
        'Issue dialog: the owner picked, the ID number checked against the record, the document seen',
      );
      await confirm.click();

      const issued = page.getByRole('dialog', {name: /^Extract EX-/});
      await expect(issued).toContainText(
        /Extract EX-NA-\d{4}-\d{6} issued to Petrus Nghishidi/,
      );
      const extractNo = (await issued.locator('#id-h').innerText()).split(
        ' ',
      )[1];
      await evidence(
        page,
        'API-692',
        'The extract issued: sealed by the registry, with Print and Download PDF',
      );
      const downloaded = page.waitForEvent('download');
      await issued.getByRole('button', {name: 'Download PDF'}).click();
      const pdf = await downloaded;
      expect(pdf.suggestedFilename()).toBe(`${extractNo}.pdf`);
      const body = await (await pdf.createReadStream()).toArray();
      expect(Buffer.concat(body).subarray(0, 5).toString()).toBe('%PDF-');
      await issued.getByRole('button', {name: 'Close'}).click();

      // the register: the extract, valid and current; the tab counts it
      const row = panel.locator('tbody tr', {hasText: extractNo});
      await expect(row).toContainText('Petrus Nghishidi');
      await expect(row).toContainText('v1');
      await expect(row.locator('.tag')).toHaveText('Valid · current');
      await expect(page.getByRole('tab', {name: /^Extracts/})).toContainText(
        '1',
      );

      // revoked, with a reason: withdrawn in the register, and not given out again
      await row.getByRole('button', {name: `Revoke ${extractNo}`}).click();
      const revoke = page.locator('form.dialog', {
        hasText: `Revoke extract ${extractNo}?`,
      });
      const revokeButton = revoke.getByRole('button', {
        name: 'Revoke extract',
      });
      await expect(revokeButton).toBeDisabled();
      await revoke.getByLabel(/^Reason/).fill('The owner reported it lost');
      await evidence(
        page,
        'API-692',
        'Revoke dialog: the reason is required and kept in the audit trail',
      );
      await revokeButton.click();
      await expect(toast(page, `Extract ${extractNo} revoked.`)).toBeVisible();
      await expect(row.locator('.tag')).toHaveText('Withdrawn');
      await expect(row).toContainText(': The owner reported it lost');
      await expect(
        row.getByRole('button', {name: `Download again ${extractNo}`}),
      ).toHaveCount(0);
      await expect(page.getByRole('tab', {name: /^Extracts/})).toContainText(
        '0',
      );
      await evidence(
        page,
        'API-692',
        'The register: the extract withdrawn, with who, when and why',
      );
    },
  );

  test(
    'the registrar, who may not issue extracts, has no Extracts tab',
    {tag: ['@API-692']},
    async ({page}) => {
      await openExtracts(page, 'sup');
      await expect(page.getByRole('tab', {name: 'History'})).toBeVisible();
      await expect(page.getByRole('tab', {name: /^Extracts/})).toHaveCount(0);
    },
  );
});

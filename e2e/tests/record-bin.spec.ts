/**
 * The bin (API-767): a land record that was never approved goes to the bin with a reason, out of
 * the lists, its parcel and documents free again; it comes back while its parcel is free, and not
 * once a new record holds the parcel. An abandoned change of an approved record is discarded, and
 * the History keeps what it changed, who discarded it, when and why.
 */
import {expect, test, type Page} from '@playwright/test';
import {userByRole} from '../support/catalogue';
import {signInAs} from '../support/auth';
import {apiAs} from '../support/intake';
import {evidence} from '../support/evidence';
import {fileNumbered} from '../support/samples';
import {toast} from '../support/documents';
import {committedRecord} from '../support/records';

const rnd = (from: number, span: number) =>
  from + Math.floor(Math.random() * span);
/** Erf numbers of this run, so reruns on one database start afresh. */
const ERF = rnd(30000, 9000);
const n = () => rnd(10000, 89999);
const DEED = `T ${n()}/2026`;
const CHANGE_DEED = `T ${n()}/2026`;
const parcel = (erf: number) => ({
  kind: 'erf',
  number: String(erf),
  township: 'Olympia',
  regDiv: 'K',
});

/** A record created through the API as the records officer: from a filed document, or a parcel alone. */
async function createRecord(
  playwright: Parameters<typeof apiAs>[0],
  baseURL: string,
  erf: number,
  ref?: string,
) {
  const rec = await apiAs(playwright, baseURL, userByRole('rec').email);
  const h = {headers: rec.headers};
  let edrmsDocumentId: string | undefined;
  if (ref) {
    const found = await (
      await rec.api.get(
        `/api/records/document-search?q=${encodeURIComponent(ref)}`,
        h,
      )
    ).json();
    edrmsDocumentId = found.items.find(
      (d: {ref: string}) => d.ref === ref,
    ).edrmsDocumentId;
  }
  const res = await rec.api.post('/api/records', {
    ...h,
    data: {parcel: parcel(erf), ...(edrmsDocumentId ? {edrmsDocumentId} : {})},
  });
  const body = await res.json();
  await rec.dispose();
  return {status: res.status(), body};
}

async function openRecord(page: Page, id: string) {
  await page.setViewportSize({width: 1600, height: 1000});
  await signInAs(page, userByRole('rec').email, `/link?record=${id}`);
  await expect(page.locator('header.panel.head')).toBeVisible();
}

test.describe.serial('The bin (API-767)', () => {
  test(
    'a record never approved goes to the bin with a reason; a new record for the parcel then blocks restoring it',
    {tag: ['@API-767']},
    async ({page, playwright, baseURL}) => {
      test.slow();
      await fileNumbered(playwright, baseURL!, DEED, {
        property: `ERF NO. ${ERF} OLYMPIA`,
      });
      const created = await createRecord(playwright, baseURL!, ERF, DEED);
      expect(created.status).toBe(201);
      const {id, recordNo} = created.body;
      const label = `Erf ${ERF}, Olympia`;

      await openRecord(page, id);
      const head = page.locator('header.panel.head');
      await head.getByRole('button', {name: 'Move to bin'}).click();
      const dialog = page.locator('form.dialog', {hasText: 'Move to bin'});
      await expect(dialog).toContainText(
        `${label} is free again: a new record can be created for it.`,
      );
      const move = dialog.getByRole('button', {name: 'Move to bin'});
      await expect(move).toBeDisabled();
      await dialog
        .getByLabel(/^Reason/)
        .fill('Township read wrongly from the deed of sale; recreated');
      await evidence(
        page,
        'API-767',
        'Move to bin: what happens, and the reason the History keeps',
      );
      await move.click();
      await expect(toast(page, `${label} moved to the bin`)).toBeVisible();
      await expect(head.locator('.tag')).toHaveText('In the bin');
      await expect(
        page.locator('.note.warn', {hasText: 'In the bin since'}),
      ).toContainText(
        'Reason: Township read wrongly from the deed of sale; recreated',
      );
      await expect(head.getByRole('button', {name: 'Restore'})).toBeVisible();

      // out of the list, under "In the bin" only
      const row = page.locator('.rec', {hasText: recordNo});
      await expect(row).toHaveCount(0);
      await page.locator('.chip', {hasText: 'In the bin'}).click();
      await expect(row).toContainText('In the bin');
      await evidence(
        page,
        'API-767',
        'The record list, In the bin: the record, with its note and Restore',
      );

      // its document is free again, and a new record can be created for the parcel
      const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
      const found = await (
        await rec.api.get(
          `/api/records/document-search?q=${encodeURIComponent(DEED)}`,
          {headers: rec.headers},
        )
      ).json();
      await rec.dispose();
      expect(
        found.items.find((d: {ref: string}) => d.ref === DEED).linkedTo,
      ).toEqual([]);
      const again = await createRecord(playwright, baseURL!, ERF);
      expect(again.status).toBe(201);

      // so this one can no longer be restored: the message names the new record
      await head.getByRole('button', {name: 'Restore'}).click();
      await expect(
        page.locator('.toast', {
          hasText: `has another land record now (${again.body.recordNo})`,
        }),
      ).toBeVisible();
      await expect(head.locator('.tag')).toHaveText('In the bin');
      await evidence(
        page,
        'API-767',
        'Restore refused: the parcel has another land record now, named in the message',
      );
    },
  );

  test(
    'a record in the bin is restored while its parcel is free',
    {tag: ['@API-767']},
    async ({page, playwright, baseURL}) => {
      const created = await createRecord(playwright, baseURL!, ERF + 1000);
      const {id} = created.body;
      const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
      const binned = await rec.api.post(`/api/records/${id}/bin`, {
        headers: rec.headers,
        data: {reason: 'Created by mistake'},
      });
      expect(binned.status(), await binned.text()).toBe(200);
      await rec.dispose();

      await openRecord(page, id);
      const head = page.locator('header.panel.head');
      await head.getByRole('button', {name: 'Restore'}).click();
      await expect(
        toast(page, `Erf ${ERF + 1000}, Olympia restored`),
      ).toBeVisible();
      await expect(head.locator('.tag')).toHaveText('Draft');
      await page.getByRole('tab', {name: 'History'}).click();
      const bin = page.locator('.panel', {
        hasText: 'Bin and discarded changes',
      });
      await expect(bin).toContainText('Moved to the bin');
      await expect(bin).toContainText('Reason: Created by mistake');
      await expect(bin).toContainText('Restored from the bin');
    },
  );

  test(
    'an abandoned change of an approved record is discarded; the History keeps what it changed and why',
    {tag: ['@API-767']},
    async ({page, playwright, baseURL}) => {
      test.slow();
      const erf = ERF + 2000;
      await fileNumbered(playwright, baseURL!, CHANGE_DEED, {
        property: `ERF NO. ${erf} OLYMPIA`,
      });
      const record = await committedRecord(
        playwright,
        baseURL!,
        CHANGE_DEED,
        parcel(erf),
      );
      // a change opened and edited: tenure leasehold
      const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
      const h = {headers: rec.headers};
      const opened = await (
        await rec.api.post(`/api/records/${record.id}/draft`, h)
      ).json();
      const edited = await rec.api.patch(`/api/records/${record.id}/draft`, {
        ...h,
        data: {revision: opened.draft.revision, changes: {tenure: 'leasehold'}},
      });
      expect(edited.status(), await edited.text()).toBe(200);
      await rec.dispose();

      await openRecord(page, record.id);
      const head = page.locator('header.panel.head');
      await expect(head).toContainText(
        'Draft version 2 · current is version 1',
      );
      await head.getByRole('button', {name: 'Discard draft'}).click();
      const dialog = page.locator('form.dialog', {
        hasText: 'Discard draft version 2',
      });
      await expect(dialog).toContainText(
        'The changes in draft version 2 are dropped. Version 1 stays as it is.',
      );
      await dialog.getByLabel(/^Reason/).fill('The sale fell through');
      await evidence(
        page,
        'API-767',
        'Discard draft: an abandoned change of an approved record, with the reason',
      );
      await dialog.getByRole('button', {name: 'Discard draft'}).click();
      await expect(
        toast(page, 'Draft version 2 discarded; version 1 stays current'),
      ).toBeVisible();
      await expect(head).toContainText('Version 1');
      await expect(head.locator('.tag')).toHaveText('Committed');
      await expect(
        head.getByRole('button', {name: 'Change record'}),
      ).toBeVisible();

      await page.getByRole('tab', {name: 'History'}).click();
      const bin = page.locator('.panel', {
        hasText: 'Bin and discarded changes',
      });
      await expect(bin).toContainText('Draft version 2 discarded');
      await expect(bin).toContainText('Reason: The sale fell through');
      await expect(bin).toContainText('leasehold');
      await bin.scrollIntoViewIfNeeded();
      await evidence(
        page,
        'API-767',
        'History: the discarded draft, what it changed, who discarded it, when and why',
      );
    },
  );
});

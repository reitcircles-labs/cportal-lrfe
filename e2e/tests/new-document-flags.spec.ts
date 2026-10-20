/**
 * A new document filed for a parcel that has a land record (API-766): the record is flagged, the
 * officer finds it in the list under "New document", opens a change with the document, or
 * dismisses it with a reason that the History keeps. The record itself never changes on its own.
 *
 * The documents are the canned AI's deed filed under fresh numbers for an erf of this run in
 * Olympia: the next transfer ("ERF NO. … OLYMPIA"), and a portion of the erf that names the
 * record's title deed as its prior title.
 */
import {expect, test, type Page} from '@playwright/test';
import {userByRole} from '../support/catalogue';
import {signInAs} from '../support/auth';
import {evidence} from '../support/evidence';
import {fileNumbered} from '../support/samples';
import {toast} from '../support/documents';
import {committedRecord, recordNow} from '../support/records';

const rnd = (from: number, span: number) =>
  from + Math.floor(Math.random() * span);
/** An erf of this run, so reruns on one database start afresh. */
const ERF = rnd(20000, 9000);
const n = () => rnd(10000, 89999);
const TITLE = `T ${n()}/2026`;
const NEXT = `T ${n()}/2026`;
const PORTION = `T ${n()}/2026`;
const LABEL = `Erf ${ERF}, Olympia`;

let recordId = '';

/** The records list filtered to "New document", and the record opened from it. */
async function openFromNewDocuments(page: Page) {
  await page.setViewportSize({width: 1600, height: 1000});
  await signInAs(page, userByRole('rec').email, '/link');
  await page.locator('.chip', {hasText: 'New document'}).click();
  await page.locator('.rec', {hasText: LABEL}).click();
  await expect(page.locator('header.panel.head')).toContainText(LABEL);
}

test.describe.serial('New documents for a land record (API-766)', () => {
  test.beforeAll(async ({playwright, baseURL}) => {
    test.setTimeout(240_000);
    await fileNumbered(playwright, baseURL!, TITLE, {
      property: `ERF NO. ${ERF} OLYMPIA`,
    });
    const record = await committedRecord(playwright, baseURL!, TITLE, {
      kind: 'erf',
      number: String(ERF),
      township: 'Olympia',
      regDiv: 'K',
    });
    recordId = record.id;
  });

  test(
    'the next transfer of the erf is filed: the record is flagged, and a change is opened with it',
    {tag: ['@API-766']},
    async ({page, playwright, baseURL}) => {
      await fileNumbered(playwright, baseURL!, NEXT, {
        property: `ERF NO. ${ERF} OLYMPIA`,
      });
      await expect
        .poll(
          async () =>
            (await recordNow(playwright, baseURL!, recordId)).newDocuments,
          {timeout: 20_000},
        )
        .toBe(1);
      // nothing in the record changed: still version 1, no draft
      expect(
        (await recordNow(playwright, baseURL!, recordId)).draftVersion,
      ).toBeNull();

      await openFromNewDocuments(page);
      // the list says so next to the record's status, which stays Committed
      const row = page.locator('.rec', {hasText: LABEL});
      await expect(row.locator('.newdoc')).toHaveText('New document');
      await expect(row.locator('.tag')).toHaveText('Committed');
      const note = page.locator('.note.filed', {hasText: NEXT});
      await expect(note).toContainText(
        `New document for this parcel: ${NEXT} (deed of transfer)`,
      );
      await expect(note).toContainText('Its property describes this parcel.');
      await evidence(
        page,
        'API-766',
        'A new deed for the erf: the record is listed under New document, with the note and its actions',
      );
      await note.getByRole('button', {name: 'Open a change with it'}).click();
      await expect(toast(page, `${NEXT} added to draft version 2`)).toBeVisible(
        {timeout: 15_000},
      );
      await expect(page.locator('.note.filed', {hasText: NEXT})).toHaveCount(0);
      await expect(page.locator('header.panel.head')).toContainText(
        'Draft version 2 · current is version 1',
      );
      await expect(page.locator('table.table tbody')).toContainText(NEXT);
      expect(
        (await recordNow(playwright, baseURL!, recordId)).newDocuments,
      ).toBe(0);
      await evidence(
        page,
        'API-766',
        'Open a change with it: draft version 2 holds the new deed, and the note is gone',
      );
    },
  );

  test(
    'a document that names the record’s title deed as its prior title is flagged too, and dismissed with a reason the History keeps',
    {tag: ['@API-766']},
    async ({page, playwright, baseURL}) => {
      // a portion of the erf: its property is not this parcel, but it continues the record's chain
      await fileNumbered(playwright, baseURL!, PORTION, {
        property: `Portion 1 of Erf ${ERF}, Olympia`,
        priorTitle: TITLE,
      });
      await expect
        .poll(
          async () =>
            (await recordNow(playwright, baseURL!, recordId)).newDocuments,
          {timeout: 20_000},
        )
        .toBe(1);

      await openFromNewDocuments(page);
      const note = page.locator('.note.filed', {hasText: PORTION});
      await expect(note).toContainText(
        'It names a title deed of this record as its prior title.',
      );
      // a draft is open from the first test: the document can go into it
      await expect(
        note.getByRole('button', {name: 'Add to the draft'}),
      ).toBeVisible();
      await note.getByRole('button', {name: 'Dismiss'}).click();
      const dialog = page.locator('form.dialog', {
        hasText: `Dismiss ${PORTION}?`,
      });
      const confirm = dialog.getByRole('button', {name: 'Dismiss'});
      await expect(confirm).toBeDisabled();
      await dialog
        .getByLabel('Reason')
        .fill('A subdivision: Portion 1 gets its own land record');
      await evidence(
        page,
        'API-766',
        'Dismissing a new document: the reason is required and kept in the History',
      );
      await confirm.click();
      await expect(toast(page, `${PORTION} dismissed`)).toBeVisible();
      await expect(page.locator('.note.filed', {hasText: PORTION})).toHaveCount(
        0,
      );

      await page.getByRole('tab', {name: 'History'}).click();
      const dismissed = page.locator('.panel', {
        hasText: 'Dismissed new documents',
      });
      await expect(dismissed).toContainText(PORTION);
      await expect(dismissed).toContainText(
        'Reason: A subdivision: Portion 1 gets its own land record',
      );
      await expect(dismissed).toContainText('Johannes');
      await dismissed.scrollIntoViewIfNeeded();
      await evidence(
        page,
        'API-766',
        'History: the dismissed document, who dismissed it, when and why',
      );
      expect(
        (await recordNow(playwright, baseURL!, recordId)).newDocuments,
      ).toBe(0);
    },
  );
});

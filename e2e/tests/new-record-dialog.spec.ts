/**
 * The New record dialog (API-765): a land record starts from a filed document, whose parcel is
 * filled in and checked against the other documents for the property before the record exists;
 * the officer corrects what was read wrongly, fills in what a document lacks, and a parcel that
 * already has a record is updated instead. Each document's metadata is one click away.
 *
 * The documents are the canned AI's deed and bond, filed under fresh numbers for an erf of this
 * run in Olympia, with the property the reviewer types in: one as a deed of sale words it ("Erf
 * …, Olympia, situate in the Municipality of Windhoek"), the others as title deeds do ("ERF NO. …
 * OLYMPIA"). The canned bond has no registration division.
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
const ERF = rnd(5000, 2000);
const BOND_ERF = ERF + 2000;
const CHANGE_ERF = ERF + 4000;
const n = () => rnd(10000, 89999);
const SALE = `T ${n()}/2026`;
const TITLE = `T ${n()}/2026`;
const BOND = `B ${n()}/2026`;
const BOND_TITLE = `T ${n()}/2026`;
const BOND_OTHER = `B ${n()}/2026`;
const OLD_BOND = `B ${n()}/2026`;
const CHANGE_TITLE = `T ${n()}/2026`;
const CHANGE_NEW = `T ${n()}/2026`;

/** The canned AI's deed (or bond, by its number) under `no`, filed with the property as given. */
const fileAs = (
  playwright: Parameters<typeof apiAs>[0],
  baseURL: string,
  no: string,
  property?: string,
) => fileNumbered(playwright, baseURL, no, property ? {property} : {});

/** New record, the document found and picked, and on to its parcel. */
async function startFrom(page: Page, ref: string) {
  await page.getByRole('button', {name: 'New record'}).click();
  const dialog = page.locator('form.dialog');
  await dialog.getByLabel('Find a filed document').fill(ref);
  await dialog.locator('label.pick', {hasText: ref}).first().click();
  await dialog.getByRole('button', {name: 'Next: check the parcel'}).click();
  return dialog;
}

test.describe.serial('New record dialog (API-765)', () => {
  test.beforeAll(async ({playwright, baseURL}) => {
    test.setTimeout(240_000);
    const olympia = (erf: number) => `ERF NO. ${erf} OLYMPIA`;
    await fileAs(
      playwright,
      baseURL!,
      SALE,
      `Erf ${ERF}, Olympia, situate in the Municipality of Windhoek`,
    );
    await fileAs(playwright, baseURL!, TITLE, olympia(ERF));
    await fileAs(playwright, baseURL!, BOND, olympia(ERF));
    await fileAs(playwright, baseURL!, BOND_TITLE, olympia(BOND_ERF));
    await fileAs(playwright, baseURL!, BOND_OTHER, olympia(BOND_ERF));
    // a bond over another erf (the canned bond's own), to link to the record by mistake
    await fileAs(playwright, baseURL!, OLD_BOND);
    await fileAs(playwright, baseURL!, CHANGE_TITLE, olympia(CHANGE_ERF));
  });

  test(
    'a township read wrongly from a document is shown with the documents it does not match, corrected, and the record created',
    {tag: ['@API-765']},
    async ({page}) => {
      await page.setViewportSize({width: 1600, height: 1000});
      await signInAs(page, userByRole('rec').email, '/link');
      const dialog = await startFrom(page, SALE);

      // the parcel as read, with the other documents for the erf: two do not name that township
      const township = dialog.getByLabel('Township');
      await expect(township).toHaveValue(
        'Olympia, situate in the Municipality of Windhoek',
      );
      await expect(dialog.getByLabel(/^Erf number/)).toHaveValue(String(ERF));
      await expect(dialog.getByLabel(/^Registration division/)).toHaveValue(
        'K',
      );
      await expect(dialog.locator('.docs-head')).toContainText(
        "1 match · 2 don't",
      );
      await expect(dialog.locator('#pf-township-help')).toContainText(
        "2 documents for this property don't name this township.",
      );
      const row = (ref: string) => dialog.locator('.doc-row', {hasText: ref});
      await expect(row(TITLE)).toContainText("Doesn't match");
      await expect(row(SALE)).toContainText('Matches');

      // the Details of one of them: its metadata, and why it does not match
      const details = row(TITLE).getByRole('button', {
        name: `Details of ${TITLE}`,
      });
      await details.click();
      const pop = page.getByRole('dialog', {name: `Details of ${TITLE}`});
      await expect(pop).toContainText('Not this parcel');
      await expect(pop).toContainText(
        "Its property doesn't name: situate, in, the, municipality, of, windhoek.",
      );
      await expect(pop.locator('dl').first()).toContainText(
        `Property description${`ERF NO. ${ERF} OLYMPIA`}`,
      );
      await expect(pop.locator('dl').first()).toContainText(
        'Registration divisionK',
      );
      await expect(pop.locator('dl').first()).toContainText(
        `Deed number${TITLE}`,
      );
      await evidence(
        page,
        'API-765',
        'New record from a deed of sale: the township as read, two documents that do not name it, and the Details of one',
      );
      // the keyboard closes it, and focus goes back to its button
      await page.keyboard.press('Escape');
      await expect(pop).toBeHidden();
      await expect(details).toBeFocused();

      // corrected: every document matches, and the dialog shows what the document said
      await township.fill('Olympia');
      await expect(dialog.locator('.docs-head')).toContainText('All 3 match');
      await expect(dialog.locator('#pf-township-help')).toContainText(
        'Changed from the document: “Olympia, situate in the Municipality of Windhoek”.',
      );
      await evidence(
        page,
        'API-765',
        'Township corrected to Olympia: all three documents match',
      );
      await dialog.getByRole('button', {name: 'Create record'}).click();
      await expect(toast(page, `Erf ${ERF}, Olympia created`)).toBeVisible({
        timeout: 15_000,
      });
      const head = page.locator('header.panel.head');
      await expect(head).toContainText(`Erf ${ERF}, Olympia`);
      await expect(head).toContainText('Draft version 1');
      await expect(page.locator('table.table tbody')).toContainText(SALE);
    },
  );

  test(
    'a bond without a registration division: the dialog asks for it, offers the value of the other documents, and creates the record',
    {tag: ['@API-765']},
    async ({page}) => {
      await page.setViewportSize({width: 1600, height: 1000});
      await signInAs(page, userByRole('rec').email, '/link');
      const dialog = await startFrom(page, BOND_OTHER);
      const division = dialog.getByLabel(/^Registration division/);
      await expect(division).toHaveValue('');
      await expect(dialog.locator('label[for="pf-regDiv"]')).toContainText(
        'needed',
      );
      await expect(dialog.locator('#pf-regDiv-help')).toContainText(
        'Not on this document. 1 other document for this parcel says K.',
      );
      const create = dialog.getByRole('button', {name: 'Create record'});
      await expect(create).toBeDisabled();
      await evidence(
        page,
        'API-765',
        'New record from a mortgage bond: the registration division is needed, and the other documents say K',
      );
      await dialog.getByRole('button', {name: 'Use K'}).click();
      await expect(division).toHaveValue('K');
      await expect(create).toBeEnabled();
      await create.click();
      await expect(toast(page, `Erf ${BOND_ERF}, Olympia created`)).toBeVisible(
        {timeout: 15_000},
      );
    },
  );

  test(
    'a parcel with a record in draft: the document is added to that draft instead; a linked document that is not this parcel says why',
    {tag: ['@API-765']},
    async ({page, playwright, baseURL}) => {
      await page.setViewportSize({width: 1600, height: 1000});
      await signInAs(page, userByRole('rec').email, '/link');
      const dialog = await startFrom(page, TITLE);
      const existing = dialog.locator('.existing');
      await expect(existing).toContainText(
        `Erf ${ERF}, Olympia already has a land record: update it with this document`,
      );
      await expect(existing).toContainText(
        'Draft version 1 is open: the document is added to it.',
      );
      await expect(
        dialog.getByRole('button', {name: 'Create record'}),
      ).toHaveCount(0);
      await evidence(
        page,
        'API-765',
        'The parcel already has a record in draft: the dialog offers to add the document to it',
      );
      await dialog
        .getByRole('button', {name: 'Add to draft version 1'})
        .click();
      await expect(
        toast(page, `${TITLE} added to draft version 1`),
      ).toBeVisible();
      const linked = page.locator('table.table tbody');
      await expect(linked).toContainText(TITLE);

      // a bond over another erf linked by mistake: its Details say what its property does not name
      const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
      const h = {headers: rec.headers};
      const {items} = await (
        await rec.api.get(
          `/api/records?q=${encodeURIComponent(`Erf ${ERF}, Olympia`)}`,
          h,
        )
      ).json();
      const id = items.find(
        (r: {label: string}) => r.label === `Erf ${ERF}, Olympia`,
      ).id;
      const record = await (await rec.api.get(`/api/records/${id}`, h)).json();
      const found = await (
        await rec.api.get(
          `/api/records/document-search?q=${encodeURIComponent(OLD_BOND)}`,
          h,
        )
      ).json();
      const bond = found.items.find((d: {ref: string}) => d.ref === OLD_BOND);
      const added = await rec.api.post(`/api/records/${id}/draft/documents`, {
        ...h,
        data: {
          revision: record.draft.revision,
          edrmsDocumentId: bond.edrmsDocumentId,
        },
      });
      expect(added.status(), await added.text()).toBe(200);
      await rec.dispose();

      await page.reload();
      const bondRow = linked.locator('tr', {hasText: OLD_BOND});
      await bondRow
        .getByRole('button', {name: `Details of ${OLD_BOND}`})
        .click();
      const pop = page.getByRole('dialog', {name: `Details of ${OLD_BOND}`});
      await expect(pop).toContainText('Not this parcel');
      await expect(pop).toContainText(
        `Its property doesn't name: ${ERF}, olympia.`,
      );
      await expect(pop).toContainText('as in this record');
      await expect(pop.locator('dl').first()).toContainText(
        'Property descriptionErf 1873, Klein Windhoek',
      );
      await expect(pop.locator('dl').last()).toContainText('Mortgagee');
      await evidence(
        page,
        'API-765',
        'Linked documents: the Details of a bond over another erf say what its property does not name',
      );
    },
  );

  test(
    'a parcel with an approved record: a new deed opens a change of it, with the deed added',
    {tag: ['@API-765']},
    async ({page, playwright, baseURL}) => {
      test.slow();
      // a committed record for the erf: created, completed from its deed, submitted and approved
      await committedRecord(playwright, baseURL!, CHANGE_TITLE, {
        kind: 'erf',
        number: String(CHANGE_ERF),
        township: 'Olympia',
        regDiv: 'K',
      });

      // the next transfer of the erf is filed
      await fileAs(
        playwright,
        baseURL!,
        CHANGE_NEW,
        `ERF NO. ${CHANGE_ERF} OLYMPIA`,
      );

      await page.setViewportSize({width: 1600, height: 1000});
      await signInAs(page, userByRole('rec').email, '/link');
      const dialog = await startFrom(page, CHANGE_NEW);
      const existing = dialog.locator('.existing');
      await expect(existing).toContainText(
        `Erf ${CHANGE_ERF}, Olympia already has a land record: update it with this document`,
      );
      await expect(existing).toContainText(
        'Draft version 2 opens with this document added. Version 1 stays the current version until the new one is approved.',
      );
      await evidence(
        page,
        'API-765',
        'A new deed for a parcel with an approved record: the dialog offers to open a change with it',
      );
      await dialog
        .getByRole('button', {name: 'Open a change with this document'})
        .click();
      await expect(
        toast(page, `Draft version 2 opened with ${CHANGE_NEW}`),
      ).toBeVisible();
      const head = page.locator('header.panel.head');
      await expect(head).toContainText(
        'Draft version 2 · current is version 1',
      );
      await expect(page.locator('table.table tbody')).toContainText(CHANGE_NEW);
    },
  );
});

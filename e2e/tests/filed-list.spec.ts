/**
 * Verify's Filed list after intake has cleared its copy of a filed document (API-807): the
 * document's small record keeps its reference and property, so the list still shows them and its
 * search still finds the document by them (API-815).
 */
import {expect, test} from '@playwright/test';
import {signInAs} from '../support/auth';
import {evidence} from '../support/evidence';
import {userByRole} from '../support/catalogue';
import {apiAs, filedDocument} from '../support/intake';

const tag = {tag: ['@API-807', '@API-815']};

test(
  'a filed document keeps its reference and property in the Filed list, and is found by them',
  tag,
  async ({browser, playwright, baseURL, page}) => {
    const doc = await filedDocument(playwright, baseURL!, browser);
    const rev = await apiAs(playwright, baseURL!, userByRole('rev').email);
    const summary = await (
      await rev.api.get(`/api/intake/documents/${doc.id}`, {
        headers: rev.headers,
      })
    ).json();
    await rev.dispose();
    // intake has cleared its copy, and kept the small record
    expect(summary.cleared).toBe(true);
    expect(summary.fields).toEqual([]);
    expect(summary.ref).toBeTruthy();
    expect(summary.property).toBeTruthy();
    expect(summary.reviewed).toBe(summary.total);
    expect(summary.total).toBeGreaterThan(0);
    // the list shows the property up to its first comma
    const place = summary.property.replace(/,.*/, '');

    await signInAs(page, userByRole('rev').email, '/verify');
    await page.locator('label.seg-opt', {hasText: 'Filed'}).click();
    const search = page.getByPlaceholder('Deed no., erf, file, batch');
    for (const q of [summary.ref, place]) {
      await search.fill(q);
      const row = page.locator('.qrow', {hasText: summary.ref});
      await expect(row, `searched for "${q}"`).toHaveCount(1);
      await expect(row).toContainText(place);
      await expect(row).not.toContainText(doc.fileName);
      await evidence(
        page,
        'API-815',
        q === summary.ref
          ? 'Filed list searched by reference: the cleared document shows its reference and place'
          : 'Filed list searched by place: the same document is found',
      );
    }
    // the cleared document opens, its scan from the EDRMS (API-807)
    await page.locator('.qrow', {hasText: summary.ref}).click();
    await expect(page).toHaveURL(new RegExp(`doc=${doc.id}`));
    await expect(
      page.getByText(`${summary.total} of ${summary.total} reviewed`),
    ).toBeVisible();
    await evidence(
      page,
      'API-807',
      'A filed document opened in Verify after intake cleared its copy',
    );
  },
);

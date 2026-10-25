/** Steps on screens that several tests share. */
import {expect, type Page} from '@playwright/test';
import {trackApi} from './api-idle';
import type {Api} from './intake';

/** The newest toast with this text (an earlier one may still be showing). */
export const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast', {hasText: text}).last();

/**
 * Search Documents for `edrmsNo` and open it. Waits for the search to load and the selection to
 * settle: the screen selects again after each search, which clears an integrity result shown before.
 */
export async function openInDocuments(page: Page, edrmsNo: string) {
  const apiIdle = trackApi(page);
  await page.goto('/#/documents');
  const box = page.getByLabel('Search documents');
  const row = page.locator('button.drow', {hasText: edrmsNo});
  /** Types `text` (the number, with or without a trailing space) and waits for its results. */
  const search = async (text: string) => {
    const searched = page.waitForResponse(
      r =>
        r.url().includes('/api/documents?') &&
        r.url().includes(`q=${encodeURIComponent(edrmsNo)}`),
    );
    await box.fill(text);
    await searched;
    await apiIdle();
  };
  await search(edrmsNo);
  // with EDRMS_SEARCH=opensearch a document just filed reaches the search index within a few
  // seconds (API-803): searched again until found, by adding or removing a trailing space (the
  // screen searches the trimmed text); on the database the first search finds it
  let again = 0;
  await expect(async () => {
    if (!(await row.isVisible())) {
      again++;
      await search(again % 2 ? `${edrmsNo} ` : edrmsNo);
    }
    await expect(row).toBeVisible({timeout: 1000});
  }).toPass({timeout: 20_000});
  await row.click();
  await apiIdle();
  await expect(page.locator('.doc-head')).toContainText(edrmsNo);
}

/**
 * A document search through the API (`/api/documents?q=…`, `/api/records/document-search?q=…`),
 * asked again until its items include the one `wanted` picks; that item. With
 * EDRMS_SEARCH=opensearch a document just filed reaches the search index within a few seconds
 * (API-803); on the database the first answer has it.
 */
export async function foundInSearch<T>(
  who: Pick<Api, 'api' | 'headers'>,
  url: string,
  wanted: (item: T) => boolean,
): Promise<T> {
  let hit: T | undefined;
  await expect
    .poll(
      async () => {
        const res = await who.api.get(url, {headers: who.headers});
        expect(res.status(), await res.text()).toBe(200);
        hit = ((await res.json()).items as T[]).find(wanted);
        return hit !== undefined;
      },
      {message: `found by ${url}`, timeout: 20_000},
    )
    .toBe(true);
  return hit!;
}

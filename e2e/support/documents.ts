/** Steps on screens that several tests share. */
import {expect, type Page} from '@playwright/test';
import {trackApi} from './api-idle';

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
  const searched = page.waitForResponse(
    r =>
      r.url().includes('/api/documents?') &&
      r.url().includes(`q=${encodeURIComponent(edrmsNo)}`),
  );
  await page.getByLabel('Search documents').fill(edrmsNo);
  await searched;
  await apiIdle();
  await page.locator('button.drow', {hasText: edrmsNo}).click();
  await apiIdle();
  await expect(page.locator('.doc-head')).toContainText(edrmsNo);
}

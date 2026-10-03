/**
 * One deed from scan to sealed record, passed between roles in the browser (API-606):
 *
 *   scan operator   creates a batch and uploads the scan; the (canned) AI reads it
 *   reviewer        opens it from Capture, corrects a field, accepts the rest, files it to the EDRMS
 *   records officer finds it in Documents: verified values, but no audit or correction rights
 *   auditor         checks the sealed version's integrity
 *   reviewer        requests a correction to the filed record (four-eyes)
 *   second reviewer approves it from the task inbox; the record becomes version 2.0
 *   auditor         checks the new version's integrity
 *
 * Land records (#/link) and Audit (#/audit) still show demo data, so linking the document into a
 * land record and the auditor's sign-off are not part of this test until those services exist.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { userByRole, ENROLLED_USERS } from '../support/catalogue';
import { signInAs } from '../support/auth';
import { sampleDeedPdf } from '../support/deed';
import { trackApi } from '../support/api-idle';
import { evidence } from '../support/evidence';

const SCAN = userByRole('scan');
const REVIEWER = userByRole('rev');
const RECORDS = userByRole('rec');
const AUDITOR = userByRole('aud');
// A second reviewer who may file documents: the correction must be approved by someone else.
const APPROVER = ENROLLED_USERS.find(u => u.roles.length === 1 && u.roles[0] === 'rev' && u.email !== REVIEWER.email)!;

/**
 * Each person works in their own browser context, signed in as themselves. The window is wider
 * than the default so Capture's table shows its buttons in the screenshots for Jira.
 */
async function as(browser: Browser, email: string, path: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await signInAs(page, email, path);
    return page;
}

/**
 * Search Documents for `edrmsNo` and open it. Waits for the search to load and the selection to
 * settle: the screen selects again after each search, which clears an integrity result shown before.
 */
async function openInDocuments(page: Page, edrmsNo: string) {
    const apiIdle = trackApi(page);
    await page.goto('/#/documents');
    const searched = page.waitForResponse(r => r.url().includes('/api/documents?') && r.url().includes(`q=${encodeURIComponent(edrmsNo)}`));
    await page.getByLabel('Search documents').fill(edrmsNo);
    await searched;
    await apiIdle();
    await page.locator('button.drow', { hasText: edrmsNo }).click();
    await apiIdle();
    await expect(page.locator('.doc-head')).toContainText(edrmsNo);
}

const field = (page: Page, label: string) => page.locator('section.panel', { hasText: 'Verified metadata' }).locator('tr', { hasText: label });

test('a deed goes from scan to sealed record, and a correction is approved by a second person', { tag: ['@API-606', '@API-609'] }, async ({ browser }) => {
    test.slow();   // seven people, one after the other
    const fileName = `deed-T2210-2008-${Date.now()}.pdf`;
    const source = `E2E vault ${Date.now()}`;
    let batchId = '';
    let edrmsNo = '';

    await test.step(`scan operator ${SCAN.email} uploads the scan`, async () => {
        const page = await as(browser, SCAN.email, '/capture');
        await page.getByRole('button', { name: 'New batch' }).click();
        await page.getByLabel('Source of the new batch').fill(source);
        await page.getByRole('button', { name: 'Create batch' }).click();
        // the card of our batch (another test's batch may be on screen a moment before)
        const card = page.locator('.blueprint', { hasText: source }).locator('.card-title');
        await expect(card).toHaveText(/^WDH-B\d+$/);
        batchId = (await card.textContent())!.trim();

        await page.locator('label.drop input[type=file]').setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: await sampleDeedPdf(browser) });
        await expect(page.getByText('Queued for reading')).toBeVisible();
        const row = page.locator('tbody tr', { hasText: fileName });
        await expect(row).toContainText('In review', { timeout: 30_000 });   // read by the canned AI
        await expect(row).toContainText('Deed of transfer T 2210/2008');
        await expect(row).toContainText('0/17 reviewed');
        await evidence(page, 'API-606', 'Scan operator: the uploaded scan, read by the AI, waits for review');

        // API-609: a scan operator cannot open Verify, so "Review →" is disabled for them and stays here.
        const review = row.getByRole('button', { name: 'Review →' });
        await expect(review).toHaveAttribute('aria-disabled', 'true');
        await expect(review).toHaveAttribute('title', /^Requires “View review queue”/);
        await evidence(page, 'API-609', 'After the fix: Review is disabled for the scan operator');
        await review.click({ force: true });   // Playwright will not click an aria-disabled button by itself
        await expect(page).toHaveURL(/#\/capture$/);
        await evidence(page, 'API-609', 'After the fix: clicking it keeps the scan operator on Capture');
        await page.context().close();
    });

    await test.step(`reviewer ${REVIEWER.email} corrects, accepts and files it`, async () => {
        // The reviewer opens it from the batch on Capture, with "Review →".
        const page = await as(browser, REVIEWER.email, '/capture');
        await page.getByLabel('Batch').selectOption(batchId);
        await page.locator('tbody tr', { hasText: fileName }).getByRole('button', { name: 'Review →' }).click();
        await expect(page).toHaveURL(/#\/verify\?doc=/);
        await expect(page.locator('.doc-head')).toContainText('T 2210/2008');
        await evidence(page, 'API-609', 'After the fix: Review still opens Verify for the reviewer');
        await expect(page.locator('.doc-head')).toContainText('Deed of transfer · Erf 1873, Klein Windhoek');

        // Nothing can be filed before the fields are reviewed.
        await expect(page.locator('.blockers')).toContainText('17 fields not reviewed yet');
        await expect(page.getByRole('button', { name: 'Approve & file to EDRMS' })).toBeDisabled();
        await evidence(page, 'API-606', 'Reviewer: nothing can be filed before the fields are reviewed');

        // Correct the conveyancer, as if the scan showed initials the AI missed.
        await page.locator('#f-conveyancer').fill('H. J. van Wyk');
        await page.locator('#f-conveyancer').press('Enter');
        await expect(page.locator('.frow', { has: page.locator('#f-conveyancer') })).toContainText('corrected');

        // The prior title is flagged (not in the EDRMS yet), so "accept clean" leaves it for a person.
        await page.getByRole('button', { name: /^Accept \d+ clean fields?$/ }).click();
        await expect(page.locator('.blockers')).toContainText('1 field not reviewed yet');
        await page.locator('.frow', { has: page.locator('#f-priorTitle') }).getByTitle('Accept', { exact: true }).click();
        await expect(page.locator('.blockers')).toHaveCount(0);
        await page.locator('#f-conveyancer').scrollIntoViewIfNeeded();
        await evidence(page, 'API-606', 'Reviewer: conveyancer corrected, every field reviewed, ready to file');

        await page.getByRole('button', { name: 'Approve & file to EDRMS' }).click();
        const toast = page.locator('.toast .t', { hasText: 'Filed as' });
        await expect(toast).toBeVisible();
        edrmsNo = (await toast.textContent())!.replace('Filed as', '').trim();
        expect(edrmsNo).toMatch(/^EDR-NA-\d{4}-\d{6}$/);
        await evidence(page, 'API-606', 'Reviewer: filed to the EDRMS');
        await page.context().close();
    });

    await test.step(`records officer ${RECORDS.email} sees the record, without audit or correction rights`, async () => {
        const page = await as(browser, RECORDS.email, '/documents');
        await openInDocuments(page, edrmsNo);
        await expect(page.locator('.doc-head')).toContainText('v1.0');
        await expect(field(page, 'Conveyancer')).toContainText('H. J. van Wyk');
        await expect(field(page, 'Conveyancer')).toContainText('corrected');
        await expect(field(page, 'Prior title')).toContainText('T 1502/1996');
        await expect(page.getByRole('button', { name: 'Check integrity' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Request correction' })).toHaveAttribute('aria-disabled', 'true');
        await evidence(page, 'API-606', 'Records officer: the sealed record, without integrity check or correction');
        await page.context().close();
    });

    await test.step(`auditor ${AUDITOR.email} verifies the sealed version 1.0`, async () => {
        const page = await as(browser, AUDITOR.email, '/documents');
        await openInDocuments(page, edrmsNo);
        await page.getByRole('button', { name: 'Check integrity' }).click();
        await expect(page.locator('.banner.ok')).toContainText('Integrity verified · version 1.0');
        await evidence(page, 'API-606', 'Auditor: integrity of version 1.0 verified');
        await page.context().close();
    });

    await test.step(`reviewer ${REVIEWER.email} requests a correction`, async () => {
        const page = await as(browser, REVIEWER.email, '/documents');
        await openInDocuments(page, edrmsNo);
        await page.getByRole('button', { name: 'Request correction' }).click();
        await page.locator('label.fl', { hasText: 'Consideration' }).locator('input').fill('N$ 650 000,00');
        await page.getByLabel('Reason (required)').fill('Consideration misread; the original shows N$ 650 000,00');
        await expect(page.getByText('1 field changed')).toBeVisible();
        await evidence(page, 'API-606', 'Reviewer: correction request with a reason');
        await page.getByRole('button', { name: 'Send for approval' }).click();
        await expect(page.locator('.banner', { hasText: 'Correction awaiting approval' })).toBeVisible();

        // Four eyes: the person who asked does not get the approval task.
        await page.getByRole('button', { name: 'Tasks' }).click();
        await expect(page.getByRole('menu')).not.toContainText(edrmsNo);
        await evidence(page, 'API-606', 'Reviewer: correction awaits approval; the requester gets no approval task');
        await page.context().close();
    });

    await test.step(`second reviewer ${APPROVER.email} approves it from the task inbox`, async () => {
        // (Documents, not Verify: opening Verify takes the first document in the queue for review)
        const page = await as(browser, APPROVER.email, '/documents');
        await page.getByRole('button', { name: 'Tasks' }).click();
        await page.getByRole('menuitem', { name: new RegExp(`Approve change to ${edrmsNo}`) }).click();
        const dialog = page.locator('.dialog');
        await expect(dialog).toContainText('N$ 640 000,00');
        await expect(dialog).toContainText('N$ 650 000,00');
        await evidence(page, 'API-606', 'Second reviewer: approval task from the inbox');
        await dialog.getByRole('button', { name: 'Approve' }).click();
        await expect(page.locator('.toast', { hasText: 'Change approved and applied' })).toBeVisible();

        await openInDocuments(page, edrmsNo);
        await expect(page.locator('.doc-head')).toContainText('v2.0');
        await expect(field(page, 'Consideration')).toContainText('N$ 650 000,00');
        const v2 = page.locator('.ver', { hasText: 'v2.0 · Amendment' });
        await expect(v2).toContainText(`Requested by ${REVIEWER.name} · approved by ${APPROVER.name}`);
        await expect(v2).toContainText('N$ 640 000,00 → N$ 650 000,00');
        await expect(page.locator('.ver', { hasText: 'v1.0 · Filed' })).toContainText(`Filed by ${REVIEWER.name}`);
        await v2.scrollIntoViewIfNeeded();
        await evidence(page, 'API-606', 'Second reviewer: version 2.0 with the approved change in its history');
        await page.context().close();
    });

    await test.step(`auditor ${AUDITOR.email} verifies the new version 2.0`, async () => {
        const page = await as(browser, AUDITOR.email, '/documents');
        await openInDocuments(page, edrmsNo);
        await page.getByRole('button', { name: 'Check integrity' }).click();
        await expect(page.locator('.banner.ok')).toContainText('Integrity verified · version 2.0');
        await evidence(page, 'API-606', 'Auditor: integrity of version 2.0 verified');
        await page.context().close();
    });
});

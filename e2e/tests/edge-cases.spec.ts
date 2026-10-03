/**
 * The less travelled paths of capture, review and correction (API-608): rejecting a document,
 * two reviewers on one document, a correction rejected or withdrawn, a file the station does not
 * take, and the service refusing what the screens would never send.
 *
 * Documents are prepared through the API (support/intake.ts) so each test starts at its own step.
 * Rescans and unlinking documents from land records are not here: rescans have no screen yet, and
 * land records still show demo data (API-615).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ENROLLED_USERS, userByRole } from '../support/catalogue';
import { signInAs } from '../support/auth';
import { unique } from '../support/admin';
import { apiAs, filedDocument, readyDocument, sampleDeed } from '../support/intake';
import { sampleDeedPdf } from '../support/deed';
import { trackApi } from '../support/api-idle';
import { evidence } from '../support/evidence';

const SCAN = userByRole('scan');
const REVIEWER = userByRole('rev');
const SECOND = ENROLLED_USERS.find(u => u.roles.length === 1 && u.roles[0] === 'rev' && u.email !== REVIEWER.email)!;
const tag = { tag: '@API-608' };
// Each test prepares its documents through the API and works with two or three people.
test.describe.configure({ timeout: 90_000 });

// Each test's windows are closed after it, so a failure's screenshots show only that test's screens.
const opened: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(opened.splice(0).map(c => c.close())); });

async function as(browser: Browser, email: string, path: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1600, height: 1000 } });
    opened.push(context);
    const page = await context.newPage();
    await signInAs(page, email, path);
    return page;
}

const toast = (page: Page, text: string | RegExp) => page.locator('.toast', { hasText: text }).last();

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

async function requestCorrection(page: Page, edrmsNo: string) {
    await openInDocuments(page, edrmsNo);
    await page.getByRole('button', { name: 'Request correction' }).click();
    await page.locator('label.fl', { hasText: 'Extent' }).locator('input').fill('1 215 square metres');
    await page.getByLabel('Reason (required)').fill('Extent misread on the scan');
    await page.getByRole('button', { name: 'Send for approval' }).click();
    await expect(page.locator('.banner', { hasText: 'Correction awaiting approval' })).toBeVisible();
}

test('a reviewer rejects a document with a reason; the scan operator sees why', tag, async ({ browser, playwright, baseURL }) => {
    const doc = await readyDocument(playwright, baseURL!, browser);
    const page = await as(browser, REVIEWER.email, `/verify?doc=${doc.id}`);
    await expect(page.locator('.doc-head')).toContainText(doc.deedNo);

    await page.locator('.doc-head').getByRole('button', { name: 'Reject' }).click();
    const dialog = page.locator('.dialog');
    const confirm = dialog.getByRole('button', { name: 'Reject' });
    await dialog.getByLabel('Reason (required)').fill('no');
    await expect(confirm).toBeDisabled();   // at least 3 characters
    await dialog.getByLabel('Reason (required)').fill('Duplicate of an instrument already filed');
    await evidence(page, 'API-608', 'Reject: the reviewer gives a reason');
    await confirm.click();
    await expect(toast(page, `${doc.deedNo} rejected`)).toBeVisible();

    const scan = await as(browser, SCAN.email, '/capture');
    await scan.getByLabel('Batch').selectOption(doc.batchId);
    const row = scan.locator('tbody tr', { hasText: doc.fileName });
    await expect(row).toContainText('Rejected');
    await expect(row).toContainText('Duplicate of an instrument already filed');
    await evidence(scan, 'API-608', 'Reject: the scan operator sees the document rejected, and why');

    // Nothing reached the EDRMS, and the document cannot be filed any more.
    const rev = await apiAs(playwright, baseURL!, REVIEWER.email);
    const filed = await rev.api.post(`/api/intake/documents/${doc.id}/file`, { headers: rev.headers });
    expect(filed.status()).toBe(409);
    expect((await filed.json()).message).toContain('rejected');
    await rev.dispose();
});

test('two reviewers on one document: the second can look but not change it until the first leaves', tag, async ({ browser, playwright, baseURL }) => {
    const doc = await readyDocument(playwright, baseURL!, browser);
    const first = await as(browser, REVIEWER.email, `/verify?doc=${doc.id}`);
    await expect(first.locator('#f-conveyancer')).toBeEditable();

    const second = await as(browser, SECOND.email, `/verify?doc=${doc.id}`);
    await expect(second.locator('.banner', { hasText: `${REVIEWER.name} is reviewing this document. You can look, but not change it.` })).toBeVisible();
    await expect(second.locator('#f-conveyancer')).not.toBeEditable();
    await expect(second.getByRole('button', { name: 'Approve & file to EDRMS' })).toBeDisabled();
    await evidence(second, 'API-608', 'Two reviewers: the second sees who holds the document and cannot edit');

    // The service refuses the second reviewer too, not only the screen.
    const api = await apiAs(playwright, baseURL!, SECOND.email);
    const edit = await api.api.put(`/api/intake/documents/${doc.id}/fields/conveyancer`, { headers: api.headers, data: { value: 'Someone Else' } });
    expect(edit.status()).toBe(409);
    expect((await edit.json()).message).toBe(`${REVIEWER.name} is reviewing this document`);
    await api.dispose();

    // The first reviewer moves on; the claim is released and the second can work.
    await first.goto('/#/documents');
    await expect(first.locator('header.topbar h1')).toHaveText('Documents (EDRMS)');
    await expect.poll(async () => {
        await second.reload();
        await expect(second.locator('.doc-head')).toContainText(doc.deedNo);
        return second.locator('.banner', { hasText: 'is reviewing this document' }).count();
    }, { timeout: 15_000 }).toBe(0);
    await expect(second.locator('#f-conveyancer')).toBeEditable();
});

test('the approver rejects a correction with a reason; the record stays as it was', tag, async ({ browser, playwright, baseURL }) => {
    const doc = await filedDocument(playwright, baseURL!, browser);
    const requester = await as(browser, REVIEWER.email, '/documents');
    await requestCorrection(requester, doc.edrmsNo);

    // (Documents, not Verify: opening Verify takes the first document in the queue for review)
    const approver = await as(browser, SECOND.email, '/documents');
    await approver.getByRole('button', { name: 'Tasks' }).click();
    await approver.getByRole('menuitem', { name: new RegExp(`Approve change to ${doc.edrmsNo}`) }).click();
    const dialog = approver.locator('.dialog');
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Say why you reject the change.');
    await dialog.getByLabel(/Comment/).fill('The scan clearly shows 1 214');
    await evidence(approver, 'API-608', 'Correction: the approver rejects it, with a reason');
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(toast(approver, 'Change rejected')).toBeVisible();

    await openInDocuments(approver, doc.edrmsNo);
    await expect(approver.locator('.doc-head')).toContainText('v1.0');
    await expect(approver.locator('.banner', { hasText: 'Correction awaiting approval' })).toHaveCount(0);
    await expect(approver.locator('.ver')).toHaveCount(1);
    await expect(approver.locator('section.panel', { hasText: 'Verified metadata' }).locator('tr', { hasText: 'Extent' })).toContainText('1 214 square metres');
    // The requester can ask again.
    await openInDocuments(requester, doc.edrmsNo);
    await expect(requester.getByRole('button', { name: 'Request correction' })).toBeEnabled();
});

test('the requester withdraws a correction; the approval task goes away', tag, async ({ browser, playwright, baseURL }) => {
    const doc = await filedDocument(playwright, baseURL!, browser);
    const requester = await as(browser, REVIEWER.email, '/documents');
    await requestCorrection(requester, doc.edrmsNo);

    await requester.locator('.banner', { hasText: 'Correction awaiting approval' }).getByRole('button', { name: 'Withdraw' }).click();
    await requester.getByRole('alertdialog').getByRole('button', { name: 'Withdraw' }).click();
    await expect(requester.locator('.banner', { hasText: 'Correction awaiting approval' })).toHaveCount(0);
    await evidence(requester, 'API-608', 'Correction: withdrawn by the requester; the record is unchanged');

    const approver = await as(browser, SECOND.email, '/documents');
    await approver.getByRole('button', { name: 'Tasks' }).click();
    await expect(approver.getByRole('menu')).not.toContainText(doc.edrmsNo);
});

test('the scan station refuses a file that is not a PDF, PNG or JPEG', tag, async ({ browser }) => {
    const page = await as(browser, SCAN.email, '/capture');
    const source = `E2E ${unique()}`;
    await page.getByRole('button', { name: 'New batch' }).click();
    await page.getByLabel('Source of the new batch').fill(source);
    await page.getByRole('button', { name: 'Create batch' }).click();
    await expect(page.locator('.blueprint', { hasText: source })).toBeVisible();

    await page.locator('label.drop input[type=file]').setInputFiles({ name: 'deed.tiff', mimeType: 'image/tiff', buffer: Buffer.from('II*\0not really a tiff') });
    await expect(page.locator('.up.err')).toContainText('Not a PDF, PNG or JPEG (convert TIFF first)');
    await expect(page.getByText('No documents in this batch yet.')).toBeVisible();
    await evidence(page, 'API-608', 'Capture: a TIFF is refused with advice, and nothing is added');
});

test('the service refuses to file an unreviewed document, whatever the screen allows', tag, async ({ browser, playwright, baseURL }) => {
    const doc = await readyDocument(playwright, baseURL!, browser);
    const rev = await apiAs(playwright, baseURL!, REVIEWER.email);
    const res = await rev.api.post(`/api/intake/documents/${doc.id}/file`, { headers: rev.headers });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.message).toBe('Not ready to file');
    expect(body.details.blockers.join(' ')).toMatch(/not reviewed/);
    // and a scan operator may not file at all
    const scan = await apiAs(playwright, baseURL!, SCAN.email);
    expect((await scan.api.post(`/api/intake/documents/${doc.id}/file`, { headers: scan.headers })).status()).toBe(403);
    await rev.dispose();
    await scan.dispose();
});

test('the same scan cannot be captured twice', tag, async ({ browser }) => {
    const { deedNo, fileName } = sampleDeed();
    const buffer = await sampleDeedPdf(browser, { deedNo, marker: fileName });
    const page = await as(browser, SCAN.email, '/capture');
    const source = `E2E ${unique()}`;
    await page.getByRole('button', { name: 'New batch' }).click();
    await page.getByLabel('Source of the new batch').fill(source);
    await page.getByRole('button', { name: 'Create batch' }).click();
    // the card of our batch (another test's batch may be on screen a moment before)
    const card = page.locator('.blueprint', { hasText: source }).locator('.card-title');
    await expect(card).toHaveText(/^WDH-B\d+$/);
    const batchId = (await card.textContent())!.trim();

    await page.locator('label.drop input[type=file]').setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer });
    await expect(page.locator('tbody tr', { hasText: fileName })).toBeVisible();
    // the same bytes again, under another name
    await page.locator('label.drop input[type=file]').setInputFiles({ name: `again-${fileName}`, mimeType: 'application/pdf', buffer });
    await expect(page.locator('.up.err')).toContainText(`This file was already captured (${fileName}, batch ${batchId})`);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await evidence(page, 'API-608', 'Capture: the same scan again is refused, naming where it already is');
});

test('a deed already in the EDRMS cannot be filed a second time', tag, async ({ browser, playwright, baseURL }) => {
    const deed = sampleDeed();
    const first = await filedDocument(playwright, baseURL!, browser, deed);
    // a second scan of the same deed (other bytes, same deed number)
    const again = await readyDocument(playwright, baseURL!, browser, { ...deed, fileName: deed.fileName.replace('.pdf', '-rescan.pdf') });
    const page = await as(browser, REVIEWER.email, `/verify?doc=${again.id}`);
    await expect(page.locator('.doc-head')).toContainText(deed.deedNo);
    // The review screen already flags it: the deed number conflicts with the filed record.
    const deedNo = page.locator('.frow', { has: page.locator('#f-deedNo') });
    await expect(deedNo).toContainText('conflict');
    await deedNo.click();
    await expect(deedNo).toContainText(`${deed.deedNo} is already filed as ${first.edrmsNo}`);
    await page.getByRole('button', { name: /^Accept \d+ clean fields?$/ }).click();
    await page.locator('.frow', { has: page.locator('#f-priorTitle') }).getByTitle('Accept', { exact: true }).click();
    await expect(page.locator('.blockers')).toContainText('Fix before filing: Deed number');
    await expect(page.getByRole('button', { name: 'Approve & file to EDRMS' })).toBeDisabled();
    await deedNo.scrollIntoViewIfNeeded();
    await evidence(page, 'API-608', 'Verify: a deed already filed is flagged and cannot be filed again');

    // The service refuses it too, naming the record it would duplicate.
    const rev = await apiAs(playwright, baseURL!, REVIEWER.email);
    const filed = await rev.api.post(`/api/intake/documents/${again.id}/file`, { headers: rev.headers });
    expect(filed.status()).toBe(409);
    expect(JSON.stringify(await filed.json())).toContain(`${deed.deedNo} is already filed as ${first.edrmsNo}`);
    await rev.dispose();
});

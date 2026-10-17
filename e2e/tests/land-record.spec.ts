/**
 * The Land record screen on the land-records service (API-649): a records officer builds Erf 1873
 * from the filed sample documents and submits it for review, in the browser.
 *
 * The samples are the tester documents in angular-app/docs/samples/. With the canned AI every deed
 * reads as T 2210/2008 apart from its number (taken from the file name), so the reviewer types in
 * the values of T 4521/2019 (the estate transfer) while verifying it, as a reviewer would correct
 * a misreading. The SG diagram and T 2210/2008 are filed as read.
 *
 * The first two tests run in order: the registrar reviews the record the officer submitted (API-650).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { ENROLLED_USERS, userByRole } from '../support/catalogue';
import { apiSignIn, signInAs } from '../support/auth';
import { apiAs } from '../support/intake';
import { adminApi, createUser, NEW_USER_PASSWORD } from '../support/admin';
import { evidence } from '../support/evidence';
import { pathToFileURL } from 'node:url';
import { GATEWAY_URL, REPO_DIR } from '../stack/config.mjs';

const SAMPLES = join(REPO_DIR, 'angular-app', 'docs', 'samples');

/**
 * Upload a sample as the scan operator and file it as the reviewer: `corrections` typed in, the rest
 * accepted as read. `as`: another file name (the canned AI reads its deed number from it), and
 * `reviewer`: who files it (default the demo reviewer).
 */
async function fileSample(playwright: Parameters<typeof apiAs>[0], baseURL: string, file: string, corrections: Record<string, string> = {},
    { as: name = file, reviewer }: { as?: string; reviewer?: () => Promise<{ api: import('@playwright/test').APIRequestContext; headers: Record<string, string>; dispose: () => Promise<void> }> } = {}): Promise<string> {
    const scan = await apiAs(playwright, baseURL, userByRole('scan').email);
    const batch = await (await scan.api.post('/api/intake/batches', { headers: scan.headers, data: { source: 'Tester samples' } })).json();
    const up = await scan.api.post(`/api/intake/batches/${batch.id}/documents`, {
        // under another name, another file (a comment line appended), as intake refuses a scan it has seen before
        headers: scan.headers, multipart: { file: { name, mimeType: 'application/pdf', buffer: name === file ? readFileSync(join(SAMPLES, file)) : Buffer.concat([readFileSync(join(SAMPLES, file)), Buffer.from(`\n% ${name}\n`)]) } }
    });
    expect(up.status(), await up.text()).toBe(201);
    const { id } = await up.json();
    await expect.poll(async () => (await (await scan.api.get(`/api/intake/documents/${id}`, { headers: scan.headers })).json()).status, { timeout: 30_000 }).toBe('ready');
    await scan.dispose();

    const rev = reviewer ? await reviewer() : await apiAs(playwright, baseURL, userByRole('rev').email);
    const h = { headers: rev.headers };
    await expect.poll(async () => (await rev.api.post(`/api/intake/documents/${id}/claim`, h)).status(), { timeout: 20_000 }).toBe(200);
    for (const [k, value] of Object.entries(corrections)) {
        const res = await rev.api.put(`/api/intake/documents/${id}/fields/${k}`, { ...h, data: { value } });
        expect(res.status(), `${k}: ${await res.text()}`).toBe(200);
    }
    await rev.api.post(`/api/intake/documents/${id}/accept-clean`, h);
    const detail = await (await rev.api.get(`/api/intake/documents/${id}`, h)).json();
    for (const f of detail.fields.filter((x: { status: string }) => x.status === 'pending')) {
        await rev.api.put(`/api/intake/documents/${id}/fields/${f.k}`, { ...h, data: { status: 'accepted' } });
    }
    const filed = await rev.api.post(`/api/intake/documents/${id}/file`, h);
    expect(filed.status(), await filed.text()).toBe(200);
    const { edrmsNo } = await filed.json();
    await rev.dispose();
    return edrmsNo;
}

/** T 4521/2019 as the deed reads: the late Petrus Nghishidi's half passes to his two children. */
const ESTATE_TRANSFER = {
    regDate: '9 July 2019', priorTitle: 'T 2210/2008', transferor: 'Estate of the late Petrus Nghishidi',
    tee1: 'Ndapewa Nghishidi', tee1Id: '98030100562', tee2: 'Tomas Nghishidi', tee2Id: '01112500379', share: '¼ share each'
};

/** A person in their own browser window, signed in. */
async function as(browser: Browser, email: string, path: string, password?: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await signInAs(page, email, path, password);
    return page;
}

/** A user created by the test (own password), signed in for API calls. */
async function apiAsNewUser(playwright: Parameters<typeof apiAs>[0], baseURL: string, email: string) {
    const api = await playwright.request.newContext({ baseURL });
    const token = await apiSignIn(api, email, NEW_USER_PASSWORD);
    return { api, headers: { authorization: `Bearer ${token}` }, dispose: () => api.dispose() };
}

test.describe.serial('Erf 1873 from filed documents to committed land record', () => {
test('a records officer builds Erf 1873 from the filed sample documents and submits it for review', { tag: ['@API-649', '@API-650'] }, async ({ page, playwright, baseURL }) => {
    test.slow();
    const sg = await fileSample(playwright, baseURL!, '03-SG-A-412-2007-diagram.pdf');
    const t2008 = await fileSample(playwright, baseURL!, '04-T-2210-2008-deed-of-transfer.pdf');
    const t2019 = await fileSample(playwright, baseURL!, '05-T-4521-2019-deed-of-transfer-estate.pdf', ESTATE_TRANSFER);

    await page.setViewportSize({ width: 1600, height: 1000 });
    await signInAs(page, userByRole('rec').email, '/link');
    const head = page.locator('header.panel.head');
    const linked = page.locator('table.table tbody');
    const owners = page.locator('aside.side .panel', { hasText: 'Registered owners' });
    const checks = page.locator('aside.side .panel', { hasText: 'Record checks' });
    const toast = (text: string) => page.locator('.toast', { hasText: text }).last();
    /** Close the notifications, so a screenshot shows the panels under them. */
    const clearToasts = async () => {
        for (const b of await page.locator('.toast button').all()) await b.click({ timeout: 1000 }).catch(() => {});
        await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 });
    };

    // 1: a new record from the filed T 2210/2008: the parcel is read from it
    await page.getByRole('button', { name: 'New record' }).click();
    const dialog = page.locator('form.dialog');
    await dialog.getByLabel('Find a filed document').fill('T 2210/2008');
    await dialog.locator('label.res', { hasText: 'T 2210/2008' }).first().click();
    await dialog.getByRole('button', { name: 'Create record' }).click();
    await expect(toast('Erf 1873, Klein Windhoek created')).toBeVisible();
    await expect(head).toContainText('Erf 1873, Klein Windhoek');
    await expect(head).toContainText('Draft version 1');
    await expect(head).toContainText(/LR-NA-\d{4}-\d{6}/);
    await expect(linked).toContainText(t2008);

    // 2: the documents matching this parcel are offered, with the reason
    const results = page.locator('.results');
    const row = (ref: string) => results.locator('.res', { has: page.locator(`b.num:text-is("${ref}")`) });
    await expect(row('A 412/2007')).toContainText('SG diagram cited by T 2210/2008');
    await expect(row('T 4521/2019')).toContainText('Cites T 2210/2008 as prior title');
    await clearToasts();
    await evidence(page, 'API-649', 'Land record: Erf 1873 created from T 2210/2008; matching documents offered with the reason');

    // 3: link them
    await row('A 412/2007').getByRole('button', { name: '+ Add' }).click();
    await expect(toast('A 412/2007 added')).toBeVisible();
    await row('T 4521/2019').getByRole('button', { name: '+ Add' }).click();
    await expect(toast('T 4521/2019 added')).toBeVisible();
    for (const no of [sg, t2008, t2019]) await expect(linked).toContainText(no);

    // 4: the owners the documents suggest, taken over by the officer
    await expect(owners).toContainText('From the documents: Maria Nghishidi 1/2, Ndapewa Nghishidi 1/4, Tomas Nghishidi 1/4');
    await owners.getByRole('button', { name: 'Use these owners' }).click();
    await expect(toast('Owners taken from the documents')).toBeVisible();
    for (const [name, share] of [['Maria Nghishidi', '1/2'], ['Ndapewa Nghishidi', '1/4'], ['Tomas Nghishidi', '1/4']]) {
        await expect(owners.locator('.owner', { hasText: name })).toContainText(share);
    }
    await expect(owners).toContainText('01112500379');

    // 5: extent from the SG diagram, tenure set by hand
    await page.getByRole('tab', { name: 'Details' }).click();
    await page.getByRole('button', { name: /^Use 1.214 m² from the documents$/ }).click();
    await expect(toast('Extent taken from the documents')).toBeVisible();
    await page.getByLabel('Tenure').selectOption('freehold');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(toast('Details saved')).toBeVisible();
    await expect(head).toContainText('Freehold');

    // 6: chain of title and checks
    await page.getByRole('tab', { name: 'Chain of title' }).click();
    const event = (ref: string) => page.locator('.ev', { has: page.locator(`span.num:text-is("${ref}")`) });
    await expect(event('T 2210/2008')).toContainText('Johannes Shikongo → Petrus Nghishidi, Maria Nghishidi');
    await expect(event('T 4521/2019')).toContainText('Estate of the late Petrus Nghishidi → Ndapewa Nghishidi, Tomas Nghishidi');
    await expect(checks).toContainText('5 / 5 required');
    await expect(checks.locator('.check-mark:not(.ok)')).toHaveCount(0);
    await clearToasts();
    await evidence(page, 'API-649', 'Land record: owners, chain of title and all checks passing for Erf 1873');

    // 7: submit for review
    await page.getByRole('tab', { name: /Documents/ }).click();
    await head.getByRole('button', { name: 'Submit for review' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Submit Erf 1873, Klein Windhoek for review?');
    await expect(confirm).toContainText('Owners: Maria Nghishidi 1/2, Ndapewa Nghishidi 1/4, Tomas Nghishidi 1/4');
    await confirm.getByRole('button', { name: 'Submit for review' }).click();
    await expect(toast('Erf 1873, Klein Windhoek submitted for review')).toBeVisible();
    await expect(head.locator('.tag')).toHaveText('In review');
    await expect(head).toContainText('Waiting for approval by a second person');
    await expect(head.getByRole('button', { name: 'Withdraw from review' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add' })).toHaveCount(0);
    await clearToasts();
    await evidence(page, 'API-649', 'Land record: Erf 1873 submitted for review');

    // the approval task waits for the registrar, not for the officer who submitted
    const sup = await apiAs(playwright, baseURL!, userByRole('sup').email);
    const tasks = (await (await sup.api.get('/api/tasks', { headers: sup.headers })).json()).tasks;
    expect(tasks.map((t: { title: string }) => t.title)).toContainEqual(expect.stringMatching(/^Approve land record LR-NA-\d{4}-\d{6} \(Erf 1873, Klein Windhoek\) version 1$/));
    await sup.dispose();
});

test('the registrar reviews it: a reject returns it with the comment, an approval makes it current, and the history shows each version', { tag: ['@API-650'] }, async ({ browser, playwright, baseURL }) => {
    test.slow();
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    const { items } = await (await rec.api.get('/api/records?q=1873', { headers: rec.headers })).json();
    const id = items.find((r: { label: string }) => r.label === 'Erf 1873, Klein Windhoek').id;
    await rec.dispose();

    const officer = await as(browser, userByRole('rec').email, `/link?record=${id}`);
    const registrar = await as(browser, userByRole('sup').email, '/');
    const head = officer.locator('header.panel.head');
    const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text }).last();
    const dialog = registrar.locator('form.dialog');

    /** The registrar opens the land record task from the bell. */
    async function openTask(version: number) {
        await registrar.getByRole('button', { name: 'Tasks' }).click();
        await registrar.locator('.menu .item', { hasText: `(Erf 1873, Klein Windhoek) version ${version}` }).click();
        await expect(dialog).toContainText('Land record');
        await expect(dialog.locator('.rv')).toBeVisible();
    }
    /** The officer submits the open draft. */
    async function submit() {
        await head.getByRole('button', { name: 'Submit for review' }).click();
        await officer.getByRole('alertdialog').getByRole('button', { name: 'Submit for review' }).click();
        await expect(toast(officer, 'submitted for review')).toBeVisible();
    }

    // 1: the review shows the submitter, the checks and what the version contains
    await openTask(1);
    await expect(dialog).toContainText(`Submitted by${userByRole('rec').name}`);
    await expect(dialog.locator('.rv')).toContainText('Shares add up to 1');
    await expect(dialog.locator('.rv')).toContainText('What this version contains');
    await expect(dialog.locator('.rv')).toContainText('Owner Maria Nghishidi 1/2');
    await expect(dialog.locator('.rv')).toContainText('Document T 4521/2019');
    // the officer who submitted it has no such task
    await expect(officer.getByRole('button', { name: 'Tasks' }).locator('.count')).toHaveCount(0);

    // 2: reject: a comment is required
    await dialog.getByRole('button', { name: 'Return to records officer' }).click();
    await expect(dialog).toContainText('Say what the records officer should fix.');
    await dialog.getByLabel(/Comment/).fill('Add the zoning from the town planning scheme.');
    await evidence(registrar, 'API-650', 'Review: the registrar sees the checks and the contents, and returns it with a comment');
    await dialog.getByRole('button', { name: 'Return to records officer' }).click();
    await expect(toast(registrar, 'Erf 1873, Klein Windhoek returned to the records officer')).toBeVisible();

    // 3: the officer sees the comment, fixes it and submits again
    await officer.reload();
    await expect(officer.locator('.note', { hasText: 'Returned by the reviewer' })).toContainText('Add the zoning from the town planning scheme.');
    await expect(head.locator('.tag')).toHaveText('Draft');
    await officer.getByRole('tab', { name: 'Details' }).click();
    await officer.getByRole('button', { name: '+ Add attribute' }).click();
    await officer.getByLabel('Attribute name').fill('zoning');
    await officer.getByLabel('Attribute value').fill('Residential');
    await officer.getByRole('button', { name: 'Save details' }).click();
    await expect(toast(officer, 'Details saved')).toBeVisible();
    await submit();

    // 4: approve: version 1 becomes current
    await openTask(1);
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(toast(registrar, 'Erf 1873, Klein Windhoek approved: version 1 is now current')).toBeVisible();
    await officer.reload();
    await expect(head.locator('.tag')).toHaveText('Committed');
    await expect(head).toContainText('Version 1');

    // 5: a change: version 2, with the difference shown to the reviewer
    await head.getByRole('button', { name: 'Change record' }).click();
    await expect(head).toContainText('Draft version 2 · current is version 1');
    await officer.getByRole('tab', { name: 'Details' }).click();
    await officer.getByLabel('Attribute value').fill('General Residential 1');
    await officer.getByRole('button', { name: 'Save details' }).click();
    await expect(toast(officer, 'Details saved')).toBeVisible();
    await submit();
    await openTask(2);
    await expect(dialog.locator('.rv')).toContainText('Changes since version 1');
    await expect(dialog.locator('.rv tr', { hasText: 'zoning' })).toContainText('Residential');
    await expect(dialog.locator('.rv tr', { hasText: 'zoning' })).toContainText('General Residential 1');
    await evidence(registrar, 'API-650', 'Review of version 2: the difference from the current version');
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(toast(registrar, 'version 2 is now current')).toBeVisible();

    // 6: the history: both versions, who and when, seals verified
    await officer.reload();
    await officer.getByRole('tab', { name: 'History' }).click();
    const versions = officer.locator('.hv');
    await expect(versions).toHaveCount(2);
    await expect(versions.nth(0)).toContainText('Version 2 · current');
    await expect(versions.nth(0)).toContainText(`approved by ${userByRole('sup').name}`);
    await expect(versions.nth(0)).toContainText('General Residential 1');
    await expect(versions.nth(1)).toContainText('Version 1');
    await expect(versions.nth(1)).toContainText(`submitted by ${userByRole('rec').name}`);
    await expect(versions.nth(0).locator('.tag').first()).toHaveText('Seal verified');
    await expect(versions.nth(1).locator('.tag').first()).toHaveText('Seal verified');
    // the audit service has the version in its tree; no anchoring runs in the e2e stack (API-658, wording API-661)
    await expect(versions.nth(1).locator('.tag').nth(1)).toHaveText('Waiting for next batch');
    await expect(officer.locator('.panel-head', { hasText: 'Committed versions' })).toContainText('Seal chain intact');
    await evidence(officer, 'API-650', 'History: both committed versions with submitter, approver and verified seals');

    // 7: a correction to a linked document in the EDRMS (requested by a reviewer, approved by another)
    // flags the record; the committed version is unchanged
    const reader = await apiAs(playwright, baseURL!, userByRole('sup').email);
    const record = await (await reader.api.get(`/api/records/${id}`, { headers: reader.headers })).json();
    await reader.dispose();
    const t2019 = record.current.data.documents.find((d: { ref: string }) => d.ref === 'T 4521/2019');
    const reviewer = userByRole('rev');
    const second = ENROLLED_USERS.find(u => u.roles.length === 1 && u.roles[0] === 'rev' && u.email !== reviewer.email)!;
    const rev = await apiAs(playwright, baseURL!, reviewer.email);
    const started = await rev.api.post('/api/processes/document-amendment/instances', { headers: rev.headers, data: { variables: {
        documentId: t2019.edrmsDocumentId, expectedVersion: 1, reason: 'Transferee 2 ID corrected from the original deed', changes: [{ k: 'tee2Id', v: '01112500380' }]
    } } });
    expect(started.status(), await started.text()).toBe(201);
    await rev.dispose();
    const approver = await apiAs(playwright, baseURL!, second.email);
    const { tasks } = await (await approver.api.get('/api/tasks', { headers: approver.headers })).json();
    const task = tasks.find((t: { document?: { id: string } }) => t.document?.id === t2019.edrmsDocumentId);
    expect((await approver.api.post(`/api/tasks/${task.id}/complete`, { headers: approver.headers, data: { output: { outcome: 'approved' } } })).status()).toBe(200);
    await approver.dispose();

    const banner = officer.locator('.note', { hasText: 'Document updated' });
    await expect.poll(async () => { await officer.reload(); return banner.count(); }, { timeout: 15_000 }).toBe(1);
    await expect(banner).toContainText(`Document updated: ${t2019.edrmsNo} v1 → v2. Review needed.`);
    await expect(banner).toContainText('Transferee 2 ID corrected from the original deed');
    await expect(head.locator('.tag')).toHaveText('Needs review');
    await expect(officer.locator('table.table tbody tr', { hasText: 'T 4521/2019' })).toContainText('v2.0 in EDRMS');
    await evidence(officer, 'API-650', 'A corrected document in the EDRMS flags the record: review needed');
});

test('an auditor\'s finding on Erf 1873 reaches the records officer\'s inbox, with who raised it, and is acknowledged', { tag: ['@API-659'] }, async ({ browser, playwright, baseURL }) => {
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    const { items } = await (await rec.api.get('/api/records?q=1873', { headers: rec.headers })).json();
    const record = await (await rec.api.get(`/api/records/${items.find((r: { label: string }) => r.label === 'Erf 1873, Klein Windhoek').id}`, { headers: rec.headers })).json();
    await rec.dispose();
    const auditor = userByRole('aud');
    const aud = await apiAs(playwright, baseURL!, auditor.email);
    const raised = await aud.api.post('/api/audit/findings', { headers: aud.headers, data: { recordId: record.id, version: record.currentVersion, description: 'Extent on the record differs from SG diagram A 412/2007' } });
    expect(raised.status(), await raised.text()).toBe(201);
    const finding = await raised.json();

    const officer = await as(browser, userByRole('rec').email, `/link?record=${record.id}`);
    await officer.getByRole('button', { name: 'Tasks' }).click();
    await officer.locator('.menu .item', { hasText: `Audit finding on ${record.recordNo}` }).click();
    const dialog = officer.locator('form.dialog');
    await expect(dialog).toContainText(`Raised by${auditor.name}`);
    await expect(dialog).toContainText('FindingExtent on the record differs from SG diagram A 412/2007');
    await expect(dialog).toContainText(`Land record${record.recordNo}`);
    await evidence(officer, 'API-659', 'An audit finding in the records officer\'s inbox: who raised it and what');
    await dialog.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(officer.locator('.toast', { hasText: 'Finding acknowledged' }).last()).toBeVisible();

    // still open until resolved or closed; the auditor closes it (the registrar's task is withdrawn)
    expect((await (await aud.api.get(`/api/audit/findings/${finding.id}`, { headers: aud.headers })).json()).status).toBe('open');
    const closed = await aud.api.post(`/api/audit/findings/${finding.id}/close`, { headers: aud.headers, data: { reason: 'Checked against the original diagram: the record is right' } });
    expect(closed.status(), await closed.text()).toBe(200);
    await aud.dispose();
});

test('the audit of Erf 1873 is one checkpoint: findings are answered by auditors, and nothing is signed off before it is on the blockchain', { tag: ['@API-680'] }, async ({ playwright, baseURL }) => {
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    const { items } = await (await rec.api.get('/api/records?q=1873', { headers: rec.headers })).json();
    const record = await (await rec.api.get(`/api/records/${items.find((r: { label: string }) => r.label === 'Erf 1873, Klein Windhoek').id}`, { headers: rec.headers })).json();
    const aud = await apiAs(playwright, baseURL!, userByRole('aud').email);

    // the open checkpoint: every committed version, waiting for the next batch (no anchoring runs in the e2e stack)
    const check = await (await aud.api.get(`/api/audit/records/${record.id}/check`, { headers: aud.headers })).json();
    expect(check.range).toEqual({ from: 1, to: record.currentVersion });
    expect(check.versions.map((v: { anchoring: string }) => v.anchoring)).toEqual(Array(record.currentVersion).fill('waiting'));
    expect(check.canSignOff).toBe(false);
    expect(check.reason).toBe('Some items go to the blockchain with the next batch. You can sign off once everything is there.');
    const early = await aud.api.post('/api/audit/signoffs', { headers: aud.headers, data: { recordId: record.id } });
    expect([early.status(), (await early.json()).message]).toEqual([409, check.reason]);

    // a finding is a thread: any auditor answers it, the records desk cannot; closing needs an answer and an outcome
    const finding = await (await aud.api.post('/api/audit/findings', { headers: aud.headers, data: { recordId: record.id, version: record.currentVersion, description: 'Zoning on the record differs from the town planning scheme' } })).json();
    const answered = await aud.api.post(`/api/audit/findings/${finding.id}/answers`, { headers: aud.headers, data: { text: 'Asked the records office for the scheme extract' } });
    expect(answered.status(), await answered.text()).toBe(201);
    expect((await rec.api.post(`/api/audit/findings/${finding.id}/answers`, { headers: rec.headers, data: { text: 'We are on it' } })).status()).toBe(403);
    expect((await aud.api.post(`/api/audit/findings/${finding.id}/close`, { headers: aud.headers, data: { outcome: 'agreed' } })).status()).toBe(400);
    const closed = await aud.api.post(`/api/audit/findings/${finding.id}/close`, { headers: aud.headers, data: { outcome: 'agreed', answer: 'Agreed with the Registrar in the meeting of 14 Oct 2026: the record is right' } });
    expect(closed.status(), await closed.text()).toBe(200);
    const body = await closed.json();
    expect([body.status, body.outcome]).toEqual(['closed', 'agreed']);
    // the trail is written by the audit service's consumer, so it may follow a moment later
    const closingEntry = async () => {
        const trail = await (await aud.api.get(`/api/audit/trail?subject=record:${record.id}&type=audit.finding.closed`, { headers: aud.headers })).json();
        return trail.entries.find((e: { data: { findingId: string } }) => e.data.findingId === finding.id);
    };
    await expect.poll(closingEntry, { timeout: 15_000 }).toBeTruthy();
    const last = await closingEntry();
    expect(last.data.Findings[0].answers.map((a: { text: string }) => a.text)).toEqual(['Asked the records office for the scheme extract']);

    // the registrar has no audit.signoff: refused (sod2 itself is covered by the audit unit tests)
    const registrar = await apiAs(playwright, baseURL!, userByRole('sup').email);
    expect((await registrar.api.post('/api/audit/signoffs', { headers: registrar.headers, data: { recordId: record.id } })).status()).toBe(403);
    await Promise.all([rec.dispose(), aud.dispose(), registrar.dispose()]);
});

test('the Audit screens: an auditor finds Erf 1873, opens its audit, reviews a document and answers and closes a finding', { tag: ['@API-661'] }, async ({ browser }) => {
    test.setTimeout(90_000);                    // a long walk through both screens, with screenshots
    const auditor = userByRole('aud');
    const page = await as(browser, auditor.email, '/audit');

    // the list: How audit works, search, the filters with counts, the record's open audit
    await expect(page.getByRole('button', { name: /How audit works/ })).toBeVisible();
    await expect(page.locator('.how-step')).toHaveCount(3);
    await page.getByPlaceholder('Erf number, township, owner or deed number').fill('1873');
    const row = page.locator('table.table tbody tr', { hasText: 'Erf 1873, Klein Windhoek' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Waiting for next batch');
    await expect(row).toContainText(/v1–v2 · \d+ new documents/);
    await expect(row).toContainText('Not all on the blockchain yet');
    await expect(page.getByRole('button', { name: /Changed since last audit/ })).toContainText('1');
    // an (i) explanation opens on click
    await page.getByRole('button', { name: 'Explain: proof status' }).click();
    await expect(page.getByRole('tooltip')).toContainText('Once an hour the new fingerprints go to a public blockchain');
    await evidence(page, 'API-661', 'The Audit list: How audit works, search, filters with counts, and Erf 1873 with its open audit');

    // one land record: the checkpoint, waiting for the blockchain, so the sign-off is disabled with the reason
    await row.getByRole('link', { name: 'Open Erf 1873, Klein Windhoek for audit' }).click();
    await expect(page.getByRole('heading', { name: 'Erf 1873, Klein Windhoek', exact: true })).toBeVisible();
    await expect(page.locator('.audit-box')).toContainText('v1–v2');
    const side = page.locator('aside.side');
    await expect(side).toContainText('Everything on the blockchain');
    await expect(side).toContainText('Some items go to the blockchain with the next batch. You can sign off once everything is there.');
    await expect(side.getByRole('button', { name: 'Sign off v1–v2' })).toBeDisabled();
    await expect(page.locator('.ver')).toHaveCount(2);
    await expect(page.locator('.ver').first()).toContainText('Waiting for the blockchain');
    await evidence(page, 'API-661', 'One land record: the audit sign-off card with its checklist; signing off waits for the blockchain');

    // a version's changes are locked until it is on the blockchain and matches (newest first: v1 is last)
    await page.locator('.ver').last().click();
    await side.getByRole('tab', { name: '2 · Check changes' }).click();
    await expect(side).toContainText('only what is on the blockchain can be trusted');
    await expect(side.getByRole('button', { name: 'Changes match: mark checked' })).toHaveCount(0);

    // the review opens the document that was clicked, with its status
    await page.getByRole('button', { name: 'Show v2, the newest' }).click();
    const sg = page.locator('table.table tbody tr', { hasText: 'A 412/2007' });
    await sg.getByRole('button', { name: /^Review/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /A 412\/2007/ })).toBeVisible();
    await expect(page.locator('.status')).toContainText('No issues');
    await evidence(page, 'API-661', 'The review of the document that was clicked: its status, page images, blockchain check, metadata and findings');

    // a finding raised in the review makes it Open, with the reason; answered and closed by agreement, it is No issues again
    await page.getByRole('button', { name: 'Raise finding' }).click();
    await page.getByRole('dialog').locator('textarea').fill('The extent on the diagram is hard to read on page 1');
    await page.getByRole('dialog').getByRole('button', { name: 'Raise finding' }).click();
    await expect(page.locator('.status')).toContainText(/Open · Auditor finding #/);
    const thread = page.locator('app-finding-thread');
    await thread.locator('textarea').fill('Compared with the original in the vault: the extent reads 1 214 square metres');
    await thread.getByRole('button', { name: 'Add answer' }).click();
    await expect(thread).toContainText('answered');
    await thread.locator('textarea').fill('Agreed with the Registrar in the meeting of 14 Oct 2026: the record is right');
    await thread.getByRole('button', { name: 'Answer and close' }).click();
    await expect(thread).toContainText('resolved by agreement');
    await expect(page.locator('.status')).toContainText('No issues');
    // the toasts fade by themselves; the screenshot waits for them
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 });
    await thread.scrollIntoViewIfNeeded();
    await evidence(page, 'API-661', 'A finding as a thread: raised, answered and closed as resolved by agreement; the document has no issues again');

    // back on the record, the trail shows what happened
    await page.getByRole('button', { name: /← Erf 1873, Klein Windhoek/ }).click();
    await expect(page.locator('app-audit-trail')).toContainText('Closed finding');
});

test('the Audit screens are read-only for whoever may not sign off', { tag: ['@API-661'] }, async ({ browser, playwright, baseURL }) => {
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    const { items } = await (await rec.api.get('/api/records?q=1873', { headers: rec.headers })).json();
    const id = items.find((r: { label: string }) => r.label === 'Erf 1873, Klein Windhoek').id;
    await rec.dispose();
    const registrar = await as(browser, userByRole('sup').email, `/audit/records/${id}`);
    const side = registrar.locator('aside.side');
    await expect(side).toContainText('You can view and verify. Signing off and raising findings need the auditor role.');
    await expect(side.getByRole('button', { name: /Sign off/ })).toHaveCount(0);
});

// ------------------------------------------------ Anchorings (API-698). The test stack has no blockchain: the
// administrator makes up a batch that expired and the confirmed one that replaced it (POST /api/audit/test/anchorings),
// after every test above, which expect nothing on the blockchain yet.

/** Erf 1873 and its deed T 2210/2008, read as the records officer. */
async function erf1873(playwright: Parameters<typeof apiAs>[0], baseURL: string) {
    const rec = await apiAs(playwright, baseURL, userByRole('rec').email);
    const { items } = await (await rec.api.get('/api/records?q=1873', { headers: rec.headers })).json();
    const record = await (await rec.api.get(`/api/records/${items.find((r: { label: string }) => r.label === 'Erf 1873, Klein Windhoek').id}`, { headers: rec.headers })).json();
    await rec.dispose();
    const deed = record.current.data.documents.find((d: { ref: string }) => d.ref === 'T 2210/2008');
    return { id: record.id as string, recordNo: record.recordNo as string, version: record.currentVersion as number, deedNo: deed.edrmsNo as string, deedId: deed.edrmsDocumentId as string };
}

/** The made-up batches: { failed, confirmed }, made once. */
let batches: { failed: number; confirmed: number } | null = null;

/** The land record's row on a batch page, after showing more until it is there. */
async function rowOf(page: Page, label: string): Promise<Locator> {
    const covers = page.locator('section', { has: page.getByRole('heading', { name: /What it covers/ }) });
    const row = covers.locator('tbody tr', { hasText: label });
    while (!(await row.count()) && await covers.getByRole('button', { name: 'Show more' }).count()) {
        await covers.getByRole('button', { name: 'Show more' }).click();
    }
    return row;
}

test('Anchorings for every signed-in user: the side menu link, every batch, and "Is it on the blockchain?" for a land record and a document', { tag: ['@API-698'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(90_000);
    const admin = await apiAs(playwright, baseURL!, userByRole('adm').email);
    const make = async (outcome: string) => {
        const res = await admin.api.post('/api/audit/test/anchorings', { headers: admin.headers, data: { outcome } });
        expect(res.status(), await res.text()).toBe(201);
        return (await res.json()).batch as number;
    };
    batches = { failed: await make('failed'), confirmed: await make('confirmed') };
    await admin.dispose();
    const erf = await erf1873(playwright, baseURL!);

    // a records officer, who cannot open the Audit screen: the side menu link, no Audit tabs
    const page = await as(browser, userByRole('rec').email, '/');
    await page.getByRole('complementary', { name: 'Main navigation' }).getByRole('link', { name: 'Anchorings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Anchorings', exact: true }).last()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Audit views' })).toHaveCount(0);
    const failedRow = page.locator('table.table tbody tr', { hasText: 'Failed' }).first();
    await expect(failedRow).toContainText(`Expired before it reached the blockchain · replaced by batch ${batches.confirmed.toLocaleString('en')}`);
    const confirmedRow = page.locator('table.table tbody tr', { has: page.getByRole('link', { name: batches.confirmed.toLocaleString('en'), exact: true }) });
    await expect(confirmedRow).toContainText('Confirmed');
    await expect(confirmedRow).toContainText(`Replaced batch ${batches.failed.toLocaleString('en')}`);
    await expect(page.getByText('Gaps in batch numbers on the blockchain:')).toBeVisible();
    await expect(page.locator('.cards')).toContainText(`Batch ${batches.confirmed.toLocaleString('en')}`);
    await page.getByRole('button', { name: 'Explain: covers' }).click();
    await expect(page.getByRole('tooltip')).toContainText('How many new fingerprints this batch put on the blockchain');
    await evidence(page, 'API-698', 'Anchorings for a records officer: the side menu link, the cards, every batch with the failed one and the note on gaps');

    // the land record by its number: yes, with its history, each line linked to its batch
    const search = page.getByRole('search');
    await search.getByRole('searchbox').fill(erf.recordNo);
    await search.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText(`Yes. Everything up to v${erf.version} is on the blockchain.`)).toBeVisible();
    await expect(page.getByText(`${erf.recordNo} · Erf 1873, Klein Windhoek`)).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: `Version v${erf.version} committed` }).getByRole('link', { name: `Batch ${batches.confirmed.toLocaleString('en')} →` })).toBeVisible();
    await page.getByText('Its history on the blockchain, newest first').scrollIntoViewIfNeeded();
    await evidence(page, 'API-698', '"Is it on the blockchain?": Erf 1873 by its land record number, with its history of batches');

    // a document by its number, and words that match nothing
    await search.getByRole('searchbox').fill(erf.deedNo);
    await search.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText('Yes. This document is on the blockchain.')).toBeVisible();
    await expect(page.getByText(`${erf.deedNo} · Deed of transfer T 2210/2008`)).toBeVisible();
    await expect(page.getByText(/^Used in land record .*, v\d+$/).first()).toBeVisible();
    await evidence(page, 'API-698', '"Is it on the blockchain?": the deed T 2210/2008 by its document number, and the land record versions made of it');
    await search.getByRole('searchbox').fill('Nowhere 999999');
    await search.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText('Nothing found for “Nowhere 999999”.', { exact: false })).toBeVisible();
});

test('one batch: what is on the blockchain and what it covers, with Open audit for the auditor and the registrar but not the records officer', { tag: ['@API-698'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(90_000);
    expect(batches, 'the batches made by the test before').not.toBeNull();
    const erf = await erf1873(playwright, baseURL!);
    const path = `/anchorings/${batches!.confirmed}`;

    const auditor = await as(browser, userByRole('aud').email, path);
    await expect(auditor.getByRole('heading', { level: 1, name: `Batch ${batches!.confirmed.toLocaleString('en')}` })).toBeVisible();
    await expect(auditor.getByRole('navigation', { name: 'Audit views' })).toHaveCount(0);   // the tabs are on the list
    await expect(auditor.locator('.steps')).toContainText('Confirmed');
    await expect(auditor.getByText('What is on the blockchain')).toBeVisible();
    await expect(auditor.getByRole('link', { name: /View on a blockchain explorer/ })).toHaveAttribute('target', '_blank');
    const row = await rowOf(auditor, 'Erf 1873, Klein Windhoek');
    await expect(row).toContainText(`v${erf.version}`);
    await expect(row).toContainText(/\d+ documents · v1(–v\d+)? before it/);
    await expect(row.getByRole('link', { name: /^Open the audit of / })).toBeVisible();
    await expect(auditor.getByText('export the land record’s evidence pack', { exact: false })).toBeVisible();
    await expect(auditor.locator('section', { has: auditor.getByRole('heading', { name: /Documents in this batch/ }) })).toContainText('T 2210/2008');
    await row.scrollIntoViewIfNeeded();
    await evidence(auditor, 'API-698', 'One batch for the auditor: what it covers, each land record version with what it is made of, and Open audit');
    await auditor.locator('.steps').scrollIntoViewIfNeeded();
    await evidence(auditor, 'API-698', 'One batch: its steps, what is on the blockchain with the explorer link, and Check it yourself');
    await row.getByRole('link', { name: /^Open the audit of / }).click();
    await expect(auditor.getByRole('heading', { name: 'Erf 1873, Klein Windhoek', exact: true })).toBeVisible();

    // the registrar reads the audit pages: Open audit too
    const registrar = await as(browser, userByRole('sup').email, path);
    await expect((await rowOf(registrar, 'Erf 1873, Klein Windhoek')).getByRole('link', { name: /^Open the audit of / })).toBeVisible();

    // the records officer sees the same land records, without the button and without the evidence pack step
    const officer = await as(browser, userByRole('rec').email, path);
    const officerRow = await rowOf(officer, 'Erf 1873, Klein Windhoek');
    await expect(officerRow).toContainText(`v${erf.version}`);
    await expect(officer.getByRole('link', { name: /^Open the audit of / })).toHaveCount(0);
    await expect(officer.getByText('export the land record’s evidence pack', { exact: false })).toHaveCount(0);
    await officerRow.scrollIntoViewIfNeeded();
    await evidence(officer, 'API-698', 'One batch for a records officer: the same land records, without Open audit');
});

test('a failed batch: why it never reached the blockchain, the batch that replaced it, and the gap explained', { tag: ['@API-698'] }, async ({ browser }) => {
    expect(batches, 'the batches made by the first Anchorings test').not.toBeNull();
    const page = await as(browser, userByRole('aud').email, '/anchorings');
    await expect(page.getByRole('navigation', { name: 'Audit views' }).getByRole('link', { name: 'Land records' })).toBeVisible();
    await page.getByRole('button', { name: /^Failed/ }).click();
    await page.getByRole('link', { name: `Open batch ${batches!.failed.toLocaleString('en')}` }).click();
    await expect(page.getByRole('heading', { level: 1, name: `Batch ${batches!.failed.toLocaleString('en')}` })).toBeVisible();
    await expect(page.getByText('This batch never reached the blockchain')).toBeVisible();
    await expect(page.getByText('Expired before it reached the blockchain. The blockchain accepts a transaction only for a limited time')).toBeVisible();
    await expect(page.locator('.steps')).toContainText('Expired');
    await expect(page.locator('.replaced')).toContainText(`Batch ${batches!.confirmed.toLocaleString('en')}`);
    await expect(page.getByText('Not on the blockchain: an explorer won’t find it')).toBeVisible();
    await expect(page.getByRole('heading', { name: `Why batch ${batches!.failed.toLocaleString('en')} is missing on the blockchain` })).toBeVisible();
    await evidence(page, 'API-698', 'A failed batch: the reason, what happened, the batch that replaced it, what was prepared and the gap explained');
    await page.locator('.replaced').getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: `Batch ${batches!.confirmed.toLocaleString('en')}` })).toBeVisible();
});

test('every proof status names its batch and links to it: the Blockchain check, the trail and the Land record versions', { tag: ['@API-699'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(90_000);
    expect(batches, 'the batches made by the first Anchorings test').not.toBeNull();
    const erf = await erf1873(playwright, baseURL!);
    const inBatch = `Confirmed, in batch ${batches!.confirmed.toLocaleString('en')}: open the batch`;

    // one land record: the current version's Blockchain check names its batch
    const page = await as(browser, userByRole('aud').email, `/audit/records/${erf.id}`);
    await page.locator('.ver').first().click();
    const side = page.locator('aside.side');
    await side.getByRole('tab', { name: '1 · Blockchain check' }).click();
    await expect(side.getByRole('link', { name: inBatch })).toContainText(new RegExp(`Confirmed\\s*in batch ${batches!.confirmed.toLocaleString('en')} →`));
    await evidence(page, 'API-699', 'One land record, Blockchain check: the proof names its batch and links to it');

    // the audit trail's Proof column: each entry in the batch links to it
    const trail = page.locator('app-audit-trail');
    await trail.scrollIntoViewIfNeeded();
    await expect(trail.getByRole('link', { name: inBatch }).first()).toBeVisible();
    await evidence(page, 'API-699', 'The audit trail: each entry\'s proof names its batch and links to it');

    // following the link opens the batch page
    await side.getByRole('link', { name: inBatch }).click();
    await expect(page.getByRole('heading', { level: 1, name: `Batch ${batches!.confirmed.toLocaleString('en')}` })).toBeVisible();

    // the Land record screen: the version tags link to their batch instead of a tooltip
    const officer = await as(browser, userByRole('rec').email, `/link?record=${erf.id}`);
    await officer.getByRole('tab', { name: 'History' }).click();
    await expect(officer.getByRole('link', { name: /^On the blockchain, in batch \d+: open the batch$|^Confirmed, in batch \d+: open the batch$/ }).first()).toBeVisible();
    await officer.getByRole('link', { name: /in batch \d+: open the batch$/ }).first().scrollIntoViewIfNeeded();
    await evidence(officer, 'API-699', 'Land record versions: the proof tag names its batch and links to it');
});

test('a proof downloaded from the Audit screen passes the offline verifier, against the test blockchain', { tag: ['@API-672'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(90_000);
    expect(batches, 'the batches made by the first Anchorings test').not.toBeNull();
    const erf = await erf1873(playwright, baseURL!);

    // the auditor downloads the current version's proof from its Blockchain check tab
    const page = await as(browser, userByRole('aud').email, `/audit/records/${erf.id}`);
    await page.locator('.ver').first().click();
    const side = page.locator('aside.side');
    await side.getByRole('tab', { name: '1 · Blockchain check' }).click();
    await side.getByRole('button', { name: 'Explain: proof file' }).click();
    await expect(side.getByRole('tooltip')).toContainText('node lrfe-verify.mjs <proof file> --address addr_test');
    await evidence(page, 'API-672', 'Download proof on the Blockchain check tab, with how to check the file and the wallet address');
    const [download] = await Promise.all([page.waitForEvent('download'), side.getByRole('button', { name: 'Download proof' }).click()]);
    expect(download.suggestedFilename()).toBe(`proof-${erf.recordNo}-v${erf.version}.json`);
    const proof = JSON.parse(readFileSync(await download.path(), 'utf8'));
    expect([proof.format, proof.status, proof.anchor.batch]).toEqual(['lrfe-audit-proof/1', 'confirmed', batches!.confirmed]);

    // the offline verifier, with the published wallet address, reading the test blockchain as it would a public one
    const wallet = await (await fetch(`${GATEWAY_URL}/api/audit/anchoring/wallet`)).json();
    const { verifyProof } = await import(pathToFileURL(join(REPO_DIR, 'backend', 'services', 'audit', 'verifier', 'lrfe-verify.mjs')).href);
    const result = await verifyProof(proof, {
        address: wallet.address,
        fetchImpl: (url: string, init: RequestInit) => fetch(`${GATEWAY_URL}/api/audit/test/koios/${new URL(url).pathname.split('/').pop()}`, init)
    });
    expect(result.valid, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.map((c: { name: string }) => c.name)).toContain('paid by the anchoring wallet');

    // on the Land record's History tab for the registrar, who reads the audit pages; not for the records officer
    const registrar = await as(browser, userByRole('sup').email, `/link?record=${erf.id}`);
    await registrar.getByRole('tab', { name: 'History' }).click();
    await expect(registrar.getByRole('button', { name: 'Download proof' }).first()).toBeVisible();
    await registrar.getByRole('button', { name: 'Download proof' }).first().scrollIntoViewIfNeeded();
    await evidence(registrar, 'API-672', 'Download proof on the Land record History tab, for the registrar');
    const officer = await as(browser, userByRole('rec').email, `/link?record=${erf.id}`);
    await officer.getByRole('tab', { name: 'History' }).click();
    await expect(officer.locator('.hv').first()).toBeVisible();
    await expect(officer.getByRole('button', { name: 'Download proof' })).toHaveCount(0);

    // on the document's version history in Documents
    const docs = await as(browser, userByRole('aud').email, `/documents?id=${erf.deedId}`);
    await expect(docs.getByRole('button', { name: 'Download proof' }).first()).toBeVisible();
    await docs.getByRole('button', { name: 'Download proof' }).first().scrollIntoViewIfNeeded();
    await evidence(docs, 'API-672', 'Download proof on a document version in Documents');
});

test('Documents: a document version verified against the blockchain, and one that still waits for the next batch', { tag: ['@API-675'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(120_000);
    expect(batches, 'the batches made by the first Anchorings test').not.toBeNull();
    const erf = await erf1873(playwright, baseURL!);

    // T 2210/2008, in the test batch: every check matches, with the transaction on an explorer
    const page = await as(browser, userByRole('aud').email, `/documents?id=${erf.deedId}`);
    const history = page.locator('.panel', { has: page.getByRole('heading', { name: 'Version history' }) });
    await expect(page.getByRole('button', { name: 'Explain: check integrity' })).toBeVisible();
    await history.getByRole('button', { name: 'Verify against the blockchain', exact: true }).first().click();
    const result = history.getByRole('status').first();
    await expect(result).toContainText('Matches the blockchain ✓');
    await expect(result.locator('li')).toHaveCount(3);
    await expect(result).toContainText('Fingerprint recomputed from the file and its metadata');
    await expect(result).toContainText('Batch is in the blockchain transaction');
    await expect(result.getByRole('link')).toHaveAttribute('href', /^https:\/\/[a-z.]*cardanoscan\.io\/transaction\/[0-9a-f]{64}$/);
    await result.scrollIntoViewIfNeeded();
    await evidence(page, 'API-675', 'Documents: a document version verified against the blockchain, each check passed, with the transaction');

    // a document filed after the batch: sealed, waiting for the next batch
    const edrmsNo = await fileSample(playwright, baseURL!, '02-T-1502-1996-deed-of-transfer.pdf');
    const waiting = await as(browser, userByRole('aud').email, '/documents');
    await waiting.getByPlaceholder('EDRMS no., deed no., erf, owner').fill(edrmsNo);
    await waiting.locator('.drow', { hasText: edrmsNo }).click();
    const waitingHistory = waiting.locator('.panel', { has: waiting.getByRole('heading', { name: 'Version history' }) });
    // the audit service seals it from the event a moment after filing
    await expect(async () => {
        await waiting.reload();
        await expect(waitingHistory.getByRole('button', { name: 'Verify against the blockchain', exact: true })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await waitingHistory.getByRole('button', { name: 'Verify against the blockchain', exact: true }).click();
    await expect(waitingHistory.getByRole('status')).toContainText('Waiting for next batch: this version can be checked against the blockchain once it is there.');
    await expect(waitingHistory.getByRole('status').locator('li')).toHaveCount(1);
    await waitingHistory.scrollIntoViewIfNeeded();
    await evidence(waiting, 'API-675', 'Documents: a document version that still waits for the next batch');
});

test('the trail search: a person\'s actions, a document\'s history, and the whole trail checked intact', { tag: ['@API-673'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(90_000);
    const erf = await erf1873(playwright, baseURL!);
    const officer = userByRole('rec');
    const page = await as(browser, userByRole('aud').email, '/audit');
    await page.getByRole('navigation', { name: 'Audit views' }).getByRole('link', { name: 'Trail' }).click();
    await expect(page).toHaveURL(/#\/audit\/trail$/);
    const rows = page.locator('table.table tbody tr:not(.details)');

    // what a person did, and what was done about it (e.g. the registrar approving their submission)
    await page.getByLabel('About', { exact: true }).selectOption('user');
    await page.getByLabel('Name', { exact: true }).fill(officer.name);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(rows.filter({ hasText: 'Created land record' }).first()).toContainText(officer.name);
    await expect(rows.filter({ hasText: 'Submitted for review' }).first()).toContainText(officer.name);
    await expect(rows.filter({ hasText: 'Filed document' })).toHaveCount(0);            // filed by the reviewer, not about them
    await evidence(page, 'API-673', 'Trail search: what one person did and what was done about it, oldest first');

    // what happened to a document, by its number: filed, then used in the land record
    await page.getByLabel('About', { exact: true }).selectOption('document');
    await page.getByLabel('Document number', { exact: true }).fill(erf.deedNo);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(rows.first()).toContainText('Captured a scan');
    await expect(rows.filter({ hasText: 'Filed document' }).first()).toBeVisible();

    // an entry's details and its proof
    await rows.filter({ hasText: 'Filed document' }).first().getByRole('button', { name: 'Details' }).click();
    const details = page.locator('tr.details');
    await expect(details).toContainText('edrms.document.filed');
    await expect(details.getByRole('link', { name: /in batch \d+: open the batch$/ })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Download proof' })).toBeVisible();
    await evidence(page, 'API-673', 'Trail search: a document\'s history by its number, with one entry\'s details and proof');

    // the whole chain recomputed
    await page.getByRole('button', { name: 'Check the trail', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The trail is intact' })).toBeVisible();
    await page.getByRole('button', { name: 'Check the trail', exact: true }).scrollIntoViewIfNeeded();
    await evidence(page, 'API-673', 'Check the trail: intact, every entry links to the one before it');

    // the system administrator reads the audit pages but not land records: the land record search works for them too
    const admin = await as(browser, userByRole('adm').email, '/audit/trail');
    await admin.getByLabel('About', { exact: true }).selectOption('record');
    await admin.getByLabel('Land record number', { exact: true }).fill(erf.recordNo);
    await admin.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(admin.locator('table.table tbody tr:not(.details)').filter({ hasText: 'Created land record' }).first()).toBeVisible();
});

test('Anchoring health for administrators: healthy, then a low-balance warning while the page is open', { tag: ['@API-674'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(90_000);
    expect(batches, 'the batches made by the first Anchorings test').not.toBeNull();
    const page = await as(browser, userByRole('adm').email, '/');
    await page.getByRole('complementary', { name: 'Main navigation' }).getByRole('link', { name: 'Anchoring health' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Anchoring health' }).last()).toBeVisible();

    // healthy: the wallet, its funds, connected, the last batch, no gaps, nothing to attend to
    await expect(page.getByRole('status').filter({ hasText: 'Anchoring is working: nothing needs attention.' })).toBeVisible();
    await expect(page.locator('code.addr')).toHaveText(/^addr_test1/);
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Batch \d+$/ })).toBeVisible();
    await expect(page.getByText('None: the trail has every event.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Explain: funds' })).toBeVisible();
    expect(await page.locator('main').innerText()).not.toMatch(/Cardano|preview|Koios|Blockfrost|Ogmios|OpenBao/i);
    await evidence(page, 'API-674', 'Anchoring health, healthy: the wallet, its funds, the blockchain connection, the last and next anchoring, no trail gaps');

    // the wallet runs low: the warning, and the alert the wallet sent
    const admin = await apiAs(playwright, baseURL!, userByRole('adm').email);
    const setFunds = async (lovelace: number) => {
        const res = await admin.api.post('/api/audit/test/funds', { headers: admin.headers, data: { lovelace } });
        expect(res.status(), await res.text()).toBe(200);
    };
    await setFunds(2_000_000);
    try {
        await page.reload();
        await expect(page.getByRole('alert').filter({ hasText: 'The anchoring wallet is low on funds: 2 left, at least 5 needed.' })).toBeVisible();
        await expect(page.getByText('reported low funds')).toBeVisible();
        await evidence(page, 'API-674', 'Anchoring health with a low-balance warning, and the alert the wallet sent');
    } finally {
        await setFunds(10_000_000_000);                                                 // the next tests' batches still need funds
        await admin.dispose();
    }
});

// ------------------------------------------------ The whole audit flow (API-615): a new registrar approves version 3; once
// moved to auditing, they may not sign it off (sod2); the auditor audits v1–v3 against the blockchain, signs off, and the
// evidence pack exported after the next batch passes the offline verifier.

test('the whole audit flow: a version approved, sod2 for its approver, the audit signed off and its evidence pack verified offline', { tag: ['@API-615'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(180_000);
    expect(batches, 'the batches made by the first Anchorings test').not.toBeNull();
    const erf = await erf1873(playwright, baseURL!);
    const admin = await adminApi(playwright, baseURL!);
    // the audit trail is written from each event a moment after the action: wait for the entry a batch must cover
    const auditor = await apiAs(playwright, baseURL!, userByRole('aud').email);
    const trailHas = async (type: string, matches: (data: Record<string, unknown>) => boolean = () => true) => {
        const res = await auditor.api.get(`/api/audit/trail?subject=record:${erf.id}&type=${type}&limit=500`, { headers: auditor.headers });
        return (await res.json()).entries.some((e: { data: Record<string, unknown> }) => matches(e.data));
    };
    const makeBatch = async () => {
        const res = await admin.api.post('/api/audit/test/anchorings', { headers: admin.headers, data: { outcome: 'confirmed' } });
        expect(res.status(), await res.text()).toBe(201);
        return (await res.json()).batch as number;
    };

    // 1: a new registrar; the records officer takes the corrected T 4521/2019 into version 3 and submits it
    const registrar = await createUser(admin, ['sup'], 'registrar');
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    let record = await (await rec.api.get(`/api/records/${erf.id}`, { headers: rec.headers })).json();
    if (!record.draft) {
        const opened = await rec.api.post(`/api/records/${erf.id}/draft`, { headers: rec.headers });
        expect(opened.status(), await opened.text()).toBe(201);
        record = await (await rec.api.get(`/api/records/${erf.id}`, { headers: rec.headers })).json();
    }
    const t2019 = record.draft.data.documents.find((d: { ref: string }) => d.ref === 'T 4521/2019');
    const refreshed = await rec.api.post(`/api/records/${erf.id}/draft/documents/${t2019.edrmsDocumentId}/refresh`, { headers: rec.headers, data: { revision: record.draft.revision } });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    // the corrected deed changes Tomas Nghishidi's ID number: the officer takes the owners over from the documents again
    record = await (await rec.api.get(`/api/records/${erf.id}`, { headers: rec.headers })).json();
    const changed = await rec.api.patch(`/api/records/${erf.id}/draft`, { headers: rec.headers, data: { revision: record.draft.revision, accept: ['owners'] } });
    expect(changed.status(), await changed.text()).toBe(200);
    record = await (await rec.api.get(`/api/records/${erf.id}`, { headers: rec.headers })).json();
    const submitted = await rec.api.post(`/api/records/${erf.id}/draft/submit`, { headers: rec.headers, data: { revision: record.draft.revision } });
    expect(submitted.status(), await submitted.text()).toBe(200);
    await rec.dispose();

    // 2: the new registrar approves it: version 3, approved by them
    const reg = await apiAsNewUser(playwright, baseURL!, registrar.email);
    let task: { id: string } | undefined;
    await expect.poll(async () => {
        const { tasks } = await (await reg.api.get('/api/tasks', { headers: reg.headers })).json();
        task = tasks.find((t: { title?: string; businessKey?: string }) => t.businessKey === erf.id || (t.title ?? '').includes(erf.recordNo));
        return !!task;
    }, { timeout: 20_000 }).toBe(true);
    const approved = await reg.api.post(`/api/tasks/${task!.id}/complete`, { headers: reg.headers, data: { output: { outcome: 'approved' } } });
    expect(approved.status(), await approved.text()).toBe(200);
    await reg.dispose();
    await expect.poll(async () => {
        const r = await apiAs(playwright, baseURL!, userByRole('rec').email);
        const now = await (await r.api.get(`/api/records/${erf.id}`, { headers: r.headers })).json();
        await r.dispose();
        return now.currentVersion;
    }, { timeout: 20_000 }).toBe(3);
    await expect.poll(() => trailHas('records.record.committed', d => d['versionNumber'] === 3), { timeout: 20_000 }).toBe(true);
    await makeBatch();

    // 3: sod2: the registrar who approved v3, moved to auditing, may not sign this audit off
    const moved = await admin.api.put(`/api/users/${registrar.id}/roles`, { headers: admin.headers, data: { roles: ['aud'] } });
    expect(moved.status(), await moved.text()).toBe(200);
    const former = await as(browser, registrar.email, `/audit/records/${erf.id}`, NEW_USER_PASSWORD);
    await expect(former.locator('aside.side')).toContainText('You approved v3, which is part of this audit, so another auditor must sign it off.');
    await expect(former.locator('aside.side').getByRole('button', { name: /^Sign off/ })).toBeDisabled();
    await evidence(former, 'API-615', 'Segregation of duties: the registrar who approved v3, now an auditor, may not sign the audit off');
    const formerApi = await apiAsNewUser(playwright, baseURL!, registrar.email);
    const refused = await formerApi.api.post('/api/audit/signoffs', { headers: formerApi.headers, data: { recordId: erf.id } });
    expect([refused.status(), (await refused.json()).message]).toEqual([403, 'You approved v3, which is part of this audit, so another auditor must sign it off.']);
    await formerApi.dispose();

    // 4: the auditor finds Erf 1873 in the Audit list and opens it: the trail's chain is intact, every step from capture on
    const page = await as(browser, userByRole('aud').email, '/audit');
    await page.getByPlaceholder('Erf number, township, owner or deed number').fill('1873');
    const row = page.locator('table.table tbody tr', { hasText: 'Erf 1873, Klein Windhoek' });
    await expect(row).toContainText('v1–v3');
    await expect(row).toContainText('All match the blockchain ✓');
    await evidence(page, 'API-615', 'The Audit list: Erf 1873 with its open audit v1–v3, every item matching the blockchain');
    await row.getByRole('link', { name: 'Open Erf 1873, Klein Windhoek for audit' }).click();
    await expect(page.getByText('Trail chain intact')).toBeVisible();
    const trail = page.locator('app-audit-trail');
    await expect(trail).toContainText('Committed version');
    // newest first, 25 at a time: back to the first steps, the capture and filing of its documents
    const trailRows = trail.locator('tbody tr');
    for (let i = 0; i < 10 && await trail.getByRole('button', { name: 'Show 25 more' }).count(); i++) {
        const shown = await trailRows.count();
        await trail.getByRole('button', { name: 'Show 25 more' }).click();
        await expect.poll(() => trailRows.count(), { timeout: 30_000 }).toBeGreaterThan(shown);
    }
    await expect(trail).toContainText('Captured a scan');
    await expect(trail).toContainText('Filed document');

    // 5: a version's proof verified now: the trail entry of a commit, against the blockchain
    const commitRow = trail.locator('tr', { hasText: 'Committed version' }).first();
    await commitRow.getByRole('button', { name: 'Verify' }).click();
    await expect(commitRow).toContainText('Valid');

    // 6: the auditor checks each version's changes, then signs off v1–v3 once
    const side = page.locator('aside.side');
    for (const ver of await page.locator('.ver').all()) {
        await ver.click();
        await side.getByRole('tab', { name: '2 · Check changes' }).click();
        await side.getByRole('button', { name: 'Changes match: mark checked' }).click();
    }
    await page.getByRole('button', { name: /Erf 1873, Klein Windhoek · v1–v3/ }).click();
    await expect(side.locator('.checks li')).toHaveCount(4);
    await expect(side.locator('.checks .dot.ok')).toHaveCount(4);
    await evidence(page, 'API-615', 'The audit sign-off card: everything on and matching the blockchain, no open findings, every version checked');
    await side.getByRole('button', { name: 'Sign off v1–v3' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign off', exact: true }).click();
    await expect(page.locator('.toast', { hasText: 'Audit signed off' }).last()).toBeVisible();

    // 7: the sign-off goes on the blockchain with the next batch; then the evidence pack, checked offline
    await expect.poll(() => trailHas('audit.signoff.recorded'), { timeout: 20_000 }).toBe(true);
    await makeBatch();
    await page.reload();
    await expect(side.locator('.signed')).toContainText('✓ Audit signed off up to v3');
    await expect(side.getByRole('link', { name: /^Confirmed, in batch \d+: open the batch$/ })).toBeVisible();
    await evidence(page, 'API-615', 'Signed off up to v3, the sign-off itself confirmed on the blockchain in its batch');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export evidence pack' }).click()]);
    const packFile = await download.path();
    const wallet = await (await fetch(`${GATEWAY_URL}/api/audit/anchoring/wallet`)).json();
    const { readPack, verifyPack } = await import(pathToFileURL(join(REPO_DIR, 'backend', 'services', 'audit', 'verifier', 'lrfe-verify.mjs')).href);
    const result = await verifyPack(readPack(packFile), {
        address: wallet.address,
        fetchImpl: (url: string, init: RequestInit) => fetch(`${GATEWAY_URL}/api/audit/test/koios/${new URL(url).pathname.split('/').pop()}`, init)
    });
    expect(result.valid, JSON.stringify(result.checks.filter((c: { ok: boolean }) => !c.ok))).toBe(true);
    expect(result.unproven).toEqual([]);
    await Promise.all([admin.dispose(), auditor.dispose()]);
});

test('four-eyes finalization: a registrar who filed one of the record\'s documents gets no approval task and cannot approve', { tag: ['@API-663'] }, async ({ browser, playwright, baseURL }) => {
    test.setTimeout(150_000);
    const erf = await erf1873(playwright, baseURL!);
    const admin = await adminApi(playwright, baseURL!);
    // someone who reviews documents and may also approve land records (a duty conflict the administrator accepted)
    const filer = await createUser(admin, ['rev', 'sup'], 'filer');
    // a later survey diagram of the same parcel (it leaves the chain of title as it is)
    const edrmsNo = await fileSample(playwright, baseURL!, '03-SG-A-412-2007-diagram.pdf', {}, {
        as: 'SG-A-9131-2012-diagram.pdf', reviewer: () => apiAsNewUser(playwright, baseURL!, filer.email)
    });

    // the records officer adds it to Erf 1873's next version and submits it
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    const docs = await (await rec.api.get(`/api/documents?q=${encodeURIComponent(edrmsNo)}`, { headers: rec.headers })).json();
    const doc = docs.items.find((d: { edrmsNo: string }) => d.edrmsNo === edrmsNo);
    expect(doc?.filedById, 'filed by the new reviewer').toBe(filer.id);
    const opened = await rec.api.post(`/api/records/${erf.id}/draft`, { headers: rec.headers });
    expect(opened.status(), await opened.text()).toBe(201);
    let record = await (await rec.api.get(`/api/records/${erf.id}`, { headers: rec.headers })).json();
    const added = await rec.api.post(`/api/records/${erf.id}/draft/documents`, { headers: rec.headers, data: { revision: record.draft.revision, edrmsDocumentId: doc.id } });
    expect(added.status(), await added.text()).toBe(200);
    record = await (await rec.api.get(`/api/records/${erf.id}`, { headers: rec.headers })).json();
    const submitted = await rec.api.post(`/api/records/${erf.id}/draft/submit`, { headers: rec.headers, data: { revision: record.draft.revision } });
    expect(submitted.status(), await submitted.text()).toBe(200);
    await rec.dispose();

    // the registrar who filed it: no task in the bell; a direct attempt is refused (four-eyes)
    const title = `Approve land record ${erf.recordNo} (Erf 1873, Klein Windhoek) version ${record.draft.versionNumber}`;
    const registrar = await apiAs(playwright, baseURL!, userByRole('sup').email);
    let taskId = '';
    await expect.poll(async () => {
        const { tasks } = await (await registrar.api.get('/api/tasks', { headers: registrar.headers })).json();
        taskId = tasks.find((t: { title: string }) => t.title === title)?.id ?? '';
        return taskId;
    }, { timeout: 20_000 }).not.toBe('');
    const filerApi = await apiAsNewUser(playwright, baseURL!, filer.email);
    const { tasks: filerTasks } = await (await filerApi.api.get('/api/tasks', { headers: filerApi.headers })).json();
    expect(filerTasks.map((t: { title: string }) => t.title)).not.toContain(title);
    const refused = await filerApi.api.post(`/api/tasks/${taskId}/complete`, { headers: filerApi.headers, data: { output: { outcome: 'approved' } } });
    expect([refused.status(), (await refused.json()).message]).toEqual([403, 'You cannot act on this task: a different person must do it (four-eyes)']);
    await filerApi.dispose();
    const page = await as(browser, filer.email, '/', NEW_USER_PASSWORD);
    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(page.locator('.menu')).not.toContainText(title);
    await evidence(page, 'API-663', 'The registrar who filed one of the record\'s documents: the approval task is not in their bell');

    // another registrar approves it
    const regPage = await as(browser, userByRole('sup').email, '/');
    await regPage.getByRole('button', { name: 'Tasks' }).click();
    await expect(regPage.locator('.menu .item', { hasText: title })).toBeVisible();
    await evidence(regPage, 'API-663', 'Another registrar has the approval task in their bell');
    const approved = await registrar.api.post(`/api/tasks/${taskId}/complete`, { headers: registrar.headers, data: { output: { outcome: 'approved' } } });
    expect(approved.status(), await approved.text()).toBe(200);
    await Promise.all([registrar.dispose(), admin.dispose()]);
});

// ------------------------------------------------ Review & approve on the record page (API-729): the registrar returns
// a version of Erf 1873 and then approves it on the record itself; the Discussion shows the comments and decisions together

test('the registrar reviews on the record page: returns a version with a reason, approves it there, and the Discussion shows it all', { tag: ['@API-729'] }, async ({ browser, playwright, baseURL }) => {
    test.slow();
    const erf = await erf1873(playwright, baseURL!);
    // a records officer of its own, so the demo officer's trail is untouched
    const admin = await adminApi(playwright, baseURL!);
    const officer = await createUser(admin, ['rec'], 'review officer');
    await admin.dispose();
    const rec = await apiAsNewUser(playwright, baseURL!, officer.email);
    const h = { headers: rec.headers };
    /** The officer changes the zoning on the open draft (opening one first) and submits it. */
    async function changeAndSubmit(zoning: string) {
        let record = await (await rec.api.get(`/api/records/${erf.id}`, h)).json();
        if (!record.draft) {
            const opened = await rec.api.post(`/api/records/${erf.id}/draft`, h);
            expect(opened.status(), await opened.text()).toBe(201);
            record = await opened.json();
        }
        const edited = await rec.api.patch(`/api/records/${erf.id}/draft`, { ...h, data: { revision: record.draft.revision, changes: { attributes: { ...record.draft.data.attributes, zoning } } } });
        expect(edited.status(), await edited.text()).toBe(200);
        const submitted = await rec.api.post(`/api/records/${erf.id}/draft/submit`, { ...h, data: { revision: (await edited.json()).draft.revision } });
        expect(submitted.status(), await submitted.text()).toBe(200);
        return (await submitted.json()).draft.versionNumber as number;
    }
    const version = await changeAndSubmit('Business 1');

    // records officers may finalize too (another officer's records): the one who submitted it sees why they cannot approve it
    const officerPage = await as(browser, officer.email, `/link?record=${erf.id}&tab=review`, NEW_USER_PASSWORD);
    await expect(officerPage.getByRole('heading', { name: `Version ${version} is in review` })).toBeVisible();
    await expect(officerPage.getByRole('status').filter({ hasText: 'You submitted this version.' })).toContainText('Another person who can finalize records must approve it (four-eyes).');
    await expect(officerPage.getByRole('button', { name: `Approve version ${version}` })).toHaveCount(0);
    await officerPage.context().close();
    // whoever may not finalize records (the auditor) has no such tab: the link opens the record's documents
    const auditorPage = await as(browser, userByRole('aud').email, `/link?record=${erf.id}&tab=review`);
    await expect(auditorPage.locator('header.panel.head')).toContainText('Erf 1873, Klein Windhoek');
    await expect(auditorPage.getByRole('tab', { name: /Discussion/ })).toBeVisible();
    await expect(auditorPage.getByRole('tab', { name: /Documents/ })).toHaveAttribute('aria-selected', 'true');
    await expect(auditorPage.getByRole('tab', { name: /Review & approve/ })).toHaveCount(0);
    await auditorPage.context().close();

    // the registrar opens the task from the bell: the latest of the discussion, and the way to the record page
    const page = await as(browser, userByRole('sup').email, '/');
    const toast = (text: string) => page.locator('.toast', { hasText: text }).last();
    const title = `(Erf 1873, Klein Windhoek) version ${version}`;
    await page.getByRole('button', { name: 'Tasks' }).click();
    await page.locator('.menu .item', { hasText: title }).click();
    const dialog = page.locator('form.dialog');
    await expect(dialog.getByLabel('Latest in the discussion')).toContainText(`submitted version ${version} for review`);
    await expect(dialog.getByRole('button', { name: 'Return to records officer' })).toBeVisible();
    await evidence(page, 'API-729', 'The task in the bell: the latest of the discussion, and Review on the record page');
    await dialog.getByRole('button', { name: /Review on the record page/ }).click();

    // the Review & approve tab: waiting for this registrar, with the review and the discussion on this version
    const tab = page.getByRole('tab', { name: /Review & approve/ });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=review/);
    await expect(page.getByRole('heading', { name: `Version ${version} is waiting for your approval` })).toBeVisible();
    await expect(page.locator('.panel', { hasText: 'Checks' }).first()).toContainText('Shares add up to 1');
    await expect(page.locator('app-record-diff')).toContainText('Business 1');
    await expect(page.locator('.panel', { hasText: `Discussion on version ${version}` })).toContainText(`submitted version ${version} for review`);

    // return it: a reason is needed
    await page.getByRole('button', { name: 'Return to records officer' }).click();
    await expect(page.getByRole('alert')).toHaveText('Say what the records officer should fix.');
    await page.getByLabel(/^Comment/).fill('Business 1 needs the rezoning approval: link it, or keep General Residential 1.');
    await evidence(page, 'API-729', 'Review & approve tab: the registrar returns the version with a reason, from the record page');
    await page.getByRole('button', { name: 'Return to records officer' }).click();
    await expect(toast('Erf 1873, Klein Windhoek returned to the records officer')).toBeVisible();
    await expect(page.getByText(`Version ${version} is a draft with the records officer`)).toBeVisible();

    // the officer answers in the Discussion and submits again
    const said = await rec.api.post(`/api/records/${erf.id}/comments`, { ...h, data: { body: 'Kept General Residential 1 until the rezoning is approved.' } });
    expect(said.status(), await said.text()).toBe(201);
    await changeAndSubmit('General Residential 1');

    // approve on the record page, with a comment, after a confirmation
    await page.reload();
    await expect(page.getByRole('heading', { name: `Version ${version} is waiting for your approval` })).toBeVisible();
    await expect(page.locator('.kv')).toContainText('(submission 2)');
    await page.getByLabel(/^Comment/).fill('Checked against T 4521/2019.');
    await page.getByRole('button', { name: `Approve version ${version}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: `Approve version ${version}` }).click();
    await expect(toast(`Erf 1873, Klein Windhoek approved: version ${version} is now current`)).toBeVisible();
    await expect(page.getByText(`Version ${version} approved: nothing is waiting for approval`)).toBeVisible();
    await expect(page.locator('.kv')).toContainText(new RegExp(`Approved by\\s*${userByRole('sup').name}`));
    await expect(page.locator('.kv')).toContainText('Checked against T 4521/2019.');
    for (const b of await page.locator('.toast button').all()) await b.click({ timeout: 1000 }).catch(() => {});
    await evidence(page, 'API-729', 'Review & approve tab after approving: who submitted, who approved, and the comment');
    // the same approval task as in the bell: it is gone from there
    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(page.locator('.menu')).not.toContainText(title);

    // the Discussion: comments and decisions together, by version, oldest first
    await page.getByRole('tab', { name: /Discussion/ }).click();
    const show = page.getByRole('group', { name: 'Show' });
    const group = page.locator('.thread').first();
    await expect(page.locator('.vh').first()).toContainText(`Version ${version}`);
    await expect(group.locator('li')).toHaveText([
        new RegExp(`submitted version ${version} for review`),
        /returned it to the records officer.*Business 1 needs the rezoning approval/s,
        /Kept General Residential 1 until the rezoning is approved\./,
        new RegExp(`submitted version ${version} again`),
        new RegExp(`approved version ${version}.*Checked against T 4521/2019\\.`, 's')
    ]);
    await show.getByRole('button', { name: /^Decisions/ }).click();
    await expect(group.locator('li')).toHaveCount(4);
    await show.getByRole('button', { name: /^Comments/ }).click();
    await expect(page.locator('.thread').first().locator('li')).toHaveCount(1);
    await show.getByRole('button', { name: /^All/ }).click();
    await evidence(page, 'API-729', 'Discussion tab: the comments and the review decisions together, by version');
    await rec.dispose();
});
});

test('the Land record screen respects permissions: the registrar reads and comments, but does not edit', { tag: ['@API-649'] }, async ({ page, playwright, baseURL }) => {
    // a record of its own, created through the API
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    const number = String(20_000 + Math.floor(Math.random() * 9_999));
    const created = await rec.api.post('/api/records', { headers: rec.headers, data: { parcel: { kind: 'erf', number, township: 'Olympia', regDiv: 'K' } } });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();
    await rec.dispose();

    await signInAs(page, userByRole('sup').email, `/link?record=${id}`);
    const head = page.locator('header.panel.head');
    await expect(head).toContainText(`Erf ${number}, Olympia`);
    // record.link is not the registrar's: the buttons say so and do nothing
    const add = head.getByRole('button', { name: 'Add documents' });
    await expect(add).toHaveAttribute('aria-disabled', 'true');
    await expect(add).toHaveAttribute('title', /Requires/);
    await expect(page.getByRole('button', { name: 'New record' })).toHaveAttribute('aria-disabled', 'true');

    await page.getByRole('tab', { name: /Discussion/ }).click();
    await page.getByLabel('Comment').fill('Please link the SG diagram first.');
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.locator('.thread li', { hasText: 'Please link the SG diagram first.' })).toContainText(userByRole('sup').name);
});

test('Land record dropdowns show the value the record holds, not their first option', { tag: ['@API-612', '@API-614'] }, async ({ page, playwright, baseURL }) => {
    // values that are not the first option of their dropdown
    const rec = await apiAs(playwright, baseURL!, userByRole('rec').email);
    const number = String(30_000 + Math.floor(Math.random() * 9_999));
    const created = await rec.api.post('/api/records', { headers: rec.headers, data: { parcel: { kind: 'erf', number, township: 'Eros', regDiv: 'K' } } });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();
    const edited = await rec.api.patch(`/api/records/${id}/draft`, { headers: rec.headers, data: {
        revision: 1, reason: 'Dropdown test values',
        changes: { tenure: 'leasehold', extent: { value: 2.5, unit: 'ha' }, encumbrances: [{ type: 'other', ref: 'K 77/2020' }] }
    } });
    expect(edited.status(), await edited.text()).toBe(200);
    await rec.dispose();

    const shown = (select: Locator) => select.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex]?.text);
    await signInAs(page, userByRole('rec').email, `/link?record=${id}`);
    await expect(page.locator('header.panel.head')).toContainText(`Erf ${number}, Eros`);
    await page.getByRole('tab', { name: 'Details' }).click();
    expect.soft(await shown(page.getByLabel('Tenure')), 'tenure').toBe('Leasehold');
    expect.soft(await shown(page.getByLabel('Extent unit')), 'extent unit').toBe('ha');
    expect.soft(await shown(page.getByLabel('Type', { exact: true })), 'encumbrance type').toBe('Other');
    await evidence(page, 'API-614', 'Land record details: Tenure Leasehold, unit ha, encumbrance type Other');

    // New record: the chosen kind of parcel survives closing and reopening the dialog
    await page.getByRole('button', { name: 'New record' }).click();
    const dialog = page.locator('form.dialog');
    await dialog.locator('label.seg-opt', { hasText: 'For a parcel' }).click();
    await dialog.getByLabel('Kind of parcel').selectOption({ label: 'Farm portion' });
    await expect(dialog.getByLabel(/^Farm name/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'New record' }).click();
    await dialog.locator('label.seg-opt', { hasText: 'For a parcel' }).click();
    expect.soft(await shown(dialog.getByLabel('Kind of parcel')), 'kind of parcel after reopening').toBe('Farm portion');
    await expect(dialog.getByLabel(/^Farm name/)).toBeVisible();
    await evidence(page, 'API-614', 'New record: the Kind of parcel dropdown keeps Farm portion');
});

// ------------------------------------------------ Encumbrances from the documents (API-721): the Details tab offers the bond
// a linked mortgage bond suggests, and taking it keeps an encumbrance entered by hand.

test('the Details tab offers the bond from a linked mortgage bond, and taking it keeps a servitude entered by hand', { tag: ['@API-721'] }, async ({ browser, playwright, baseURL }) => {
    test.slow();
    // the canned AI reads a file named after a bond number as a bond over Erf 1873 in favour of Omaruru Building Society Limited
    const bondNo = await fileSample(playwright, baseURL!, '04-T-2210-2008-deed-of-transfer.pdf', {}, { as: 'B-77-2019-mortgage-bond.pdf' });

    // a records officer and a record of their own, so the Erf 1873 tests above (and their trail of the demo officer) are
    // untouched; the record has a servitude entered by hand and the bond linked
    const admin = await adminApi(playwright, baseURL!);
    const officer = await createUser(admin, ['rec'], 'bond officer');
    await admin.dispose();
    const rec = await apiAsNewUser(playwright, baseURL!, officer.email);
    const h = { headers: rec.headers };
    const created = await rec.api.post('/api/records', { ...h, data: { parcel: { kind: 'erf', number: '9721', township: 'Klein Windhoek', regDiv: 'K' } } });
    expect(created.status(), await created.text()).toBe(201);
    let record = await created.json();
    const found = await (await rec.api.get(`/api/records/document-search?q=${encodeURIComponent('B 77/2019')}&recordId=${record.id}`, h)).json();
    const bond = found.items.find((d: { edrmsNo: string }) => d.edrmsNo === bondNo);
    expect(bond, 'the filed bond in the document search').toBeTruthy();
    const linked = await rec.api.post(`/api/records/${record.id}/draft/documents`, { ...h, data: { revision: record.draft.revision, edrmsDocumentId: bond.edrmsDocumentId } });
    expect(linked.status(), await linked.text()).toBe(200);
    record = await linked.json();
    const servitude = await rec.api.patch(`/api/records/${record.id}/draft`, { ...h, data: { revision: record.draft.revision, changes: { encumbrances: [{ type: 'servitude', ref: 'K 12/1988', inFavourOf: 'City of Windhoek' }] } } });
    expect(servitude.status(), await servitude.text()).toBe(200);
    await rec.dispose();

    const page = await as(browser, officer.email, `/link?record=${record.id}`, NEW_USER_PASSWORD);
    await expect(page.locator('header.panel.head')).toContainText('Erf 9721, Klein Windhoek');
    await page.getByRole('tab', { name: 'Details' }).click();
    const encumbrances = page.locator('form.panel .stack', { has: page.locator('b', { hasText: 'Encumbrances' }) });
    const offer = encumbrances.getByRole('button', { name: 'Use B 77/2019 from the documents' });
    await expect(offer).toBeVisible();
    await expect(encumbrances.getByLabel('Reference')).toHaveCount(1);
    await offer.scrollIntoViewIfNeeded();
    await evidence(page, 'API-721', 'Details tab: the bond from the linked mortgage bond is offered next to the servitude entered by hand');

    await offer.click();
    await expect(page.locator('.toast', { hasText: 'Encumbrances taken from the documents' }).last()).toBeVisible();
    await expect(offer).toHaveCount(0);
    const refs = encumbrances.getByLabel('Reference');
    await expect(refs).toHaveCount(2);
    await expect(refs.nth(0)).toHaveValue('K 12/1988');
    await expect(refs.nth(1)).toHaveValue('B 77/2019');
    await expect(encumbrances.getByLabel('In favour of').nth(1)).toHaveValue('Omaruru Building Society Limited');
    for (const b of await page.locator('.toast button').all()) await b.click({ timeout: 1000 }).catch(() => {});
    await evidence(page, 'API-721', 'Details tab: the bond taken from the documents, the servitude kept, and no offer left');

    // saved on the draft, not only in the form
    const check = await apiAsNewUser(playwright, baseURL!, officer.email);
    const saved = await (await check.api.get(`/api/records/${record.id}`, { headers: check.headers })).json();
    expect(saved.draft.data.encumbrances).toEqual([
        { type: 'servitude', ref: 'K 12/1988', inFavourOf: 'City of Windhoek' },
        { type: 'bond', ref: 'B 77/2019', inFavourOf: 'Omaruru Building Society Limited' }
    ]);
    await check.dispose();
});

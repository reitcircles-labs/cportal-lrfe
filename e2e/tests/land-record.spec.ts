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
import { signInAs } from '../support/auth';
import { apiAs } from '../support/intake';
import { evidence } from '../support/evidence';
import { REPO_DIR } from '../stack/config.mjs';

const SAMPLES = join(REPO_DIR, 'angular-app', 'docs', 'samples');

/** Upload a sample as the scan operator and file it as the reviewer: `corrections` typed in, the rest accepted as read. */
async function fileSample(playwright: Parameters<typeof apiAs>[0], baseURL: string, file: string, corrections: Record<string, string> = {}): Promise<string> {
    const scan = await apiAs(playwright, baseURL, userByRole('scan').email);
    const batch = await (await scan.api.post('/api/intake/batches', { headers: scan.headers, data: { source: 'Tester samples' } })).json();
    const up = await scan.api.post(`/api/intake/batches/${batch.id}/documents`, {
        headers: scan.headers, multipart: { file: { name: file, mimeType: 'application/pdf', buffer: readFileSync(join(SAMPLES, file)) } }
    });
    expect(up.status(), await up.text()).toBe(201);
    const { id } = await up.json();
    await expect.poll(async () => (await (await scan.api.get(`/api/intake/documents/${id}`, { headers: scan.headers })).json()).status, { timeout: 30_000 }).toBe('ready');
    await scan.dispose();

    const rev = await apiAs(playwright, baseURL, userByRole('rev').email);
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
async function as(browser: Browser, email: string, path: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await signInAs(page, email, path);
    return page;
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
    await dialog.getByRole('button', { name: 'Reject' }).click();
    await expect(dialog).toContainText('Say what the records officer should fix.');
    await dialog.getByLabel(/Comment/).fill('Add the zoning from the town planning scheme.');
    await evidence(registrar, 'API-650', 'Review: the registrar sees the checks and the contents, and returns it with a comment');
    await dialog.getByRole('button', { name: 'Reject' }).click();
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
    return { id: record.id as string, recordNo: record.recordNo as string, version: record.currentVersion as number, deedNo: deed.edrmsNo as string };
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

    await page.getByRole('tab', { name: /Comments/ }).click();
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

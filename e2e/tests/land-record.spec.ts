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
import { expect, test, type Browser, type Page } from '@playwright/test';
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
    regDate: '12 July 2019', priorTitle: 'T 2210/2008', transferor: 'Estate of the late Petrus Nghishidi',
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
    await expect(versions.nth(0).locator('.tag')).toHaveText('Seal verified');
    await expect(versions.nth(1).locator('.tag')).toHaveText('Seal verified');
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

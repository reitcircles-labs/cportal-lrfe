/**
 * The Land record screen on the land-records service (API-649): a records officer builds Erf 1873
 * from the filed sample documents and submits it for review, in the browser.
 *
 * The samples are the tester documents in angular-app/docs/samples/. With the canned AI every deed
 * reads as T 2210/2008 apart from its number (taken from the file name), so the reviewer types in
 * the values of T 4521/2019 (the estate transfer) while verifying it, as a reviewer would correct
 * a misreading. The SG diagram and T 2210/2008 are filed as read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { userByRole } from '../support/catalogue';
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

test('a records officer builds Erf 1873 from the filed sample documents and submits it for review', { tag: ['@API-649'] }, async ({ page, playwright, baseURL }) => {
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

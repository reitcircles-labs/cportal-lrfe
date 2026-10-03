/**
 * The Land record screen still shows demo data, except for one bridge to the live system (API-617):
 * Erf 1873's documents count as filed once documents with the same references are filed in the
 * EDRMS. This follows the tester guide: file the sample deeds, then link them into Erf 1873 and
 * finalize the record.
 *
 * The samples are the tester documents in angular-app/docs/samples/. With the canned AI the deed
 * number comes from the file name, so T 2210/2008 and T 4521/2019 are filed under their own numbers.
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
        expect((await rev.api.put(`/api/intake/documents/${id}/fields/${k}`, { ...h, data: { value } })).status()).toBe(200);
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

test('the records officer finalizes Erf 1873 with the filed sample documents, as the tester guide describes', { tag: ['@API-617'] }, async ({ page, playwright, baseURL }) => {
    test.slow();
    const sg = await fileSample(playwright, baseURL!, '03-SG-A-412-2007-diagram.pdf');
    const t2008 = await fileSample(playwright, baseURL!, '04-T-2210-2008-deed-of-transfer.pdf');
    // the reviewer corrects Tomas Nghishidi's ID from the margin note, as the guide says
    const t2019 = await fileSample(playwright, baseURL!, '05-T-4521-2019-deed-of-transfer-estate.pdf', { tee2Id: '01112500379' });

    await page.setViewportSize({ width: 1600, height: 1000 });
    await signInAs(page, userByRole('rec').email, '/link');
    const head = page.locator('header.panel.head');
    const linked = page.locator('table.table tbody');
    const owners = page.locator('aside.side .panel', { hasText: 'Registered owners' });
    const checks = page.locator('aside.side .panel', { hasText: 'Record checks' });
    const finalize = head.getByRole('button', { name: 'Finalize record' });

    // 1: the demo state, with the grant and the first transfer
    await expect(head).toContainText('Erf 1873, Klein Windhoek');
    await expect(linked).toContainText('G 88/1978');
    await expect(linked).toContainText('T 1502/1996');
    await expect(owners).toContainText('Johannes Shikongo');
    await expect(owners).toContainText('1/1');
    await expect(finalize).toBeDisabled();

    // 2: the filed samples are offered as matches
    await head.getByRole('button', { name: 'Add documents' }).click();
    const results = page.locator('.results');
    // the row whose own reference is `ref` (another row may cite it as prior title)
    const row = (ref: string) => results.locator('.res', { has: page.locator(`b.num:text-is("${ref}")`) });
    await expect(row('T 2210/2008')).toContainText('98%');
    await expect(row('SG A 412/2007')).toContainText('%');
    await expect(row('T 4521/2019')).toContainText('94%');
    console.log('SG score:', (await row('SG A 412/2007').locator('.score').textContent())?.trim());
    await evidence(page, 'API-617', 'Land record: the filed sample documents are offered for Erf 1873');

    // 3-5: link them; the owners follow the chain of title
    await row('T 2210/2008').getByRole('button', { name: '+ Add' }).click();
    await expect(page.locator('.toast', { hasText: 'T 2210/2008 added to Erf 1873' }).last()).toBeVisible();
    await expect(owners).toContainText('Petrus Nghishidi');
    await expect(owners).toContainText('Maria Nghishidi');
    await row('SG A 412/2007').getByRole('button', { name: '+ Add' }).click();
    await row('T 4521/2019').getByRole('button', { name: '+ Add' }).click();
    for (const no of [sg, t2008, t2019]) await expect(linked).toContainText(no);
    for (const name of ['Maria Nghishidi', 'Ndapewa Nghishidi', 'Tomas Nghishidi']) await expect(owners).toContainText(name);
    await expect(owners).toContainText('01112500379');

    // 6: chain of title
    await page.getByRole('tab', { name: 'Chain of title' }).click();
    for (const y of ['1978', '1996', '2008', '2019']) await expect(page.locator('.ev', { hasText: y })).toHaveCount(1);
    await page.getByRole('tab', { name: /Documents/ }).click();

    // 7: every check passes
    console.log('CHECKS:', (await checks.innerText()).replace(/\s+/g, ' '));
    await expect(checks.locator('.check-mark:not(.ok)')).toHaveCount(0);
    await expect(finalize).toBeEnabled();

    // 8-9: finalize
    await finalize.click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Finalize Erf 1873, Klein Windhoek?');
    await expect(confirm).toContainText('Registered owners: Maria Nghishidi ½, Ndapewa Nghishidi ¼, Tomas Nghishidi ¼');
    await confirm.getByRole('button', { name: 'Finalize record' }).click();
    await expect(page.locator('.toast', { hasText: 'Erf 1873 record v3 committed' }).last()).toContainText('Record is ready for tokenization.');
    await expect(head).toContainText('Finalized');
    await expect(head).toContainText('version 3');
    await evidence(page, 'API-617', 'Land record: Erf 1873 finalized with the filed sample documents');
});

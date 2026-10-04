/**
 * Stored files are encrypted (API-640). Runs only with E2E_BAO=fake or E2E_BAO=real; the other specs
 * run unchanged on top of it (the deed workflow: capture, review, file, view, integrity, correction).
 *
 *   E2E_BAO=real   a throwaway OpenBao (stack/start-backend.mjs): each service's AppRole may use only
 *                  its own key, checked against the real vault
 *   E2E_DB=postgres  files are stored in folders under .stack/files: every stored file is ciphertext
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { BAO_DIR, PORTS, STACK_DIR } from '../stack/config.mjs';
import { signInAs } from '../support/auth';
import { userByRole } from '../support/catalogue';
import { apiAs, filedDocument } from '../support/intake';
import { trackApi } from '../support/api-idle';
import { evidence } from '../support/evidence';

const MODE = process.env.E2E_BAO;
const tag = { tag: '@API-640' };
test.skip(!MODE || MODE === 'off', 'only with E2E_BAO=fake or E2E_BAO=real');

const AUDITOR = userByRole('aud');
const BAO = `http://127.0.0.1:${PORTS.bao}`;

async function as(browser: Browser, email: string, path: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await signInAs(page, email, path);
    return page;
}

/** AppRole login to the throwaway OpenBao, as the given service. */
async function loginAs(service: 'edrms' | 'intake'): Promise<string> {
    const read = (f: string) => readFileSync(join(BAO_DIR, 'approle', f), 'utf8').trim();
    const res = await fetch(`${BAO}/v1/auth/approle/login`, { method: 'POST', body: JSON.stringify({ role_id: read(`${service}-role-id`), secret_id: read(`${service}-secret-id`) }) });
    expect(res.status).toBe(200);
    return (await res.json()).auth.client_token;
}
const dataKey = (token: string, key: string) =>
    fetch(`${BAO}/v1/transit/datakey/plaintext/${key}`, { method: 'POST', headers: { 'X-Vault-Token': token }, body: JSON.stringify({ bits: 256 }) }).then(r => r.status);

test('each service may use only its own key in the vault', tag, async () => {
    test.skip(MODE !== 'real', 'needs the real OpenBao (E2E_BAO=real)');
    const edrms = await loginAs('edrms'), intake = await loginAs('intake');
    expect(await dataKey(edrms, 'edrms-files')).toBe(200);
    expect(await dataKey(intake, 'intake-files')).toBe(200);
    expect(await dataKey(intake, 'edrms-files')).toBe(403);
    expect(await dataKey(edrms, 'intake-files')).toBe(403);
});

test('a record filed from an encrypted scan opens as the original and its integrity is verified', tag, async ({ browser, playwright, baseURL }) => {
    const doc = await filedDocument(playwright, baseURL!, browser);

    // the file served to the viewer is the original: its SHA-256 matches the sealed version's
    const aud = await apiAs(playwright, baseURL!, AUDITOR.email);
    const record = await (await aud.api.get(`/api/documents/${doc.documentId}`, { headers: aud.headers })).json();
    expect(JSON.stringify(record)).not.toMatch(/encryption|wrappedKey|vault:v1:|fake:v1:/);
    const link = await (await aud.api.get(`/api/documents/${doc.documentId}/content`, { headers: aud.headers })).json();
    expect(link.url).toMatch(/^\/api\/document-content\//);
    const file = await (await aud.api.get(link.url)).body();
    expect(file.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(file).digest('hex')).toBe(record.versions[0].sha256);
    await aud.dispose();

    // the auditor checks it in the browser
    const page = await as(browser, AUDITOR.email, '/documents');
    const apiIdle = trackApi(page);
    await page.getByLabel('Search documents').fill(doc.edrmsNo);
    await page.locator('button.drow', { hasText: doc.edrmsNo }).click();
    await apiIdle();
    await page.getByRole('button', { name: 'Check integrity' }).click();
    await expect(page.locator('.banner.ok')).toContainText('Integrity verified · version 1.0');
    await evidence(page, 'API-640', `Auditor: a record stored encrypted (${MODE === 'real' ? 'keys from OpenBao' : 'test keys'}) opens and its integrity is verified`);
    await page.context().close();
});

test('every stored file is ciphertext', tag, async ({ browser, playwright, baseURL }) => {
    const root = join(STACK_DIR, 'files');
    test.skip(!existsSync(root), 'files are kept in memory; run with E2E_DB=postgres to store them in folders');
    await filedDocument(playwright, baseURL!, browser);           // at least one scan and one record
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
    for (const service of ['intake', 'edrms']) {
        const files = walk(join(root, service));
        expect(files.length, service).toBeGreaterThan(0);
        for (const f of files) {
            const bytes = readFileSync(f);
            expect(bytes.subarray(0, 4).toString(), f).toBe('LRFE');
            expect(bytes.includes(Buffer.from('%PDF')), f).toBe(false);
        }
    }
});

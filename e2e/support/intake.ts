/**
 * Documents prepared through the API, so a test can start at the step it is about: a scan read by
 * the (canned) AI and waiting for review, or one already filed to the EDRMS. The deed workflow test
 * does these steps in the browser; these helpers are for the tests that build on them.
 */
import { expect, type APIRequestContext, type Browser, type PlaywrightWorkerArgs } from '@playwright/test';
import { apiSignIn } from './auth';
import { userByRole } from './catalogue';
import { unique } from './admin';
import { sampleDeedPdf } from './deed';

export interface Api { api: APIRequestContext; headers: Record<string, string>; dispose: () => Promise<void>; }

export async function apiAs(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string, email: string): Promise<Api> {
    const api = await playwright.request.newContext({ baseURL });
    const token = await apiSignIn(api, email);
    return { api, headers: { authorization: `Bearer ${token}` }, dispose: () => api.dispose() };
}

export interface ReadyDocument { id: string; batchId: string; fileName: string; deedNo: string; }

/** A deed number no other test uses on this stack, and the matching file name. */
export function sampleDeed() {
    const n = 10_000 + Math.floor(Math.random() * 89_999);
    return { deedNo: `T ${n}/2008`, fileName: `deed-T${n}-2008-${unique()}.pdf` };
}

/**
 * The scan operator uploads a sample deed (its own deed number unless given one) into a new batch;
 * resolves once it is ready for review.
 */
export async function readyDocument(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string, browser: Browser, deed = sampleDeed()): Promise<ReadyDocument> {
    const scan = await apiAs(playwright, baseURL, userByRole('scan').email);
    const batch = await (await scan.api.post('/api/intake/batches', { headers: scan.headers, data: { source: `E2E ${unique()}` } })).json();
    const { deedNo, fileName } = deed;
    const res = await scan.api.post(`/api/intake/batches/${batch.id}/documents`, {
        headers: scan.headers, multipart: { file: { name: fileName, mimeType: 'application/pdf', buffer: await sampleDeedPdf(browser, { deedNo, marker: fileName }) } }
    });
    expect(res.status(), await res.text()).toBe(201);
    const { id } = await res.json();
    await expect.poll(async () => (await (await scan.api.get(`/api/intake/documents/${id}`, { headers: scan.headers })).json()).status, { timeout: 30_000 }).toBe('ready');
    await scan.dispose();
    return { id, batchId: batch.id, fileName, deedNo };
}

export interface FiledDocument extends ReadyDocument { edrmsNo: string; documentId: string; }

/** A ready document reviewed and filed by the reviewer: every field accepted as read. */
export async function filedDocument(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string, browser: Browser, deed = sampleDeed()): Promise<FiledDocument> {
    const doc = await readyDocument(playwright, baseURL, browser, deed);
    const rev = await apiAs(playwright, baseURL, userByRole('rev').email);
    const h = { headers: rev.headers };
    // Someone who opens Verify takes the first document in the queue for a moment: wait for it.
    await expect.poll(async () => (await rev.api.post(`/api/intake/documents/${doc.id}/claim`, h)).status(), { timeout: 20_000 }).toBe(200);
    expect((await rev.api.post(`/api/intake/documents/${doc.id}/accept-clean`, h)).status()).toBe(200);
    const detail = await (await rev.api.get(`/api/intake/documents/${doc.id}`, h)).json();
    for (const f of detail.fields.filter((x: { status: string }) => x.status === 'pending')) {
        expect((await rev.api.put(`/api/intake/documents/${doc.id}/fields/${f.k}`, { ...h, data: { status: 'accepted' } })).status()).toBe(200);
    }
    const filed = await rev.api.post(`/api/intake/documents/${doc.id}/file`, h);
    expect(filed.status(), await filed.text()).toBe(200);
    const { edrmsNo, filedDocumentId } = await filed.json();
    await rev.dispose();
    return { ...doc, edrmsNo, documentId: filedDocumentId };
}

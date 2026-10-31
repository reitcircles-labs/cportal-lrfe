/**
 * The AI's page text (API-798): intake keeps it in an encrypted file, the search service reads it
 * from intake with its own token (never a browser), and filing carries it into the EDRMS, where it
 * is stored encrypted beside the filed scan. Once filed, intake clears its copy (API-807): the
 * search service then reads the text from the EDRMS, again with its own token only.
 */
import {createHmac} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import {E2E_BAO, JWT_SECRET, STACK_DIR} from '../stack/config.mjs';
import {userByRole} from '../support/catalogue';
import {apiAs, filedDocument} from '../support/intake';

const tag = {tag: ['@API-798', '@API-807']};
/** Words of the mock reading's page text (backend/services/intake/src/extraction/providers.js). */
const PAGE_WORDS = 'BE IT HEREBY MADE KNOWN';

/** A service token as the services sign it (HS256 with the shared secret). */
function serviceToken(service: string): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({alg: 'HS256', typ: 'JWT'})}.${b64({typ: 'service', sub: service, iat: now, exp: now + 300})}`;
  return `${data}.${createHmac('sha256', JWT_SECRET).update(data).digest('base64url')}`;
}

test(
  'the search service reads the AI output from intake, and from the EDRMS once filed; a browser cannot; filing carries the text into the EDRMS',
  tag,
  async ({browser, playwright, baseURL}) => {
    const doc = await filedDocument(playwright, baseURL!, browser);
    const api = await playwright.request.newContext({baseURL});
    const asSearch = {authorization: `Bearer ${serviceToken('search')}`};

    // filed: intake has cleared its copy (API-807)
    const reading = await api.get(`/api/intake/documents/${doc.id}/reading`, {
      headers: asSearch,
    });
    expect(reading.status(), await reading.text()).toBe(200);
    const body = await reading.json();
    expect(body.status).toBe('filed');
    expect(body.cleared).toBe(true);
    expect(body.pages).toEqual([]);
    expect(body.fields).toEqual([]);
    expect(body.filedDocumentId).toBe(doc.documentId);
    // the EDRMS has the page text and the AI's values
    const kept = await api.get(`/api/documents/${doc.documentId}/reading`, {
      headers: asSearch,
    });
    expect(kept.status(), await kept.text()).toBe(200);
    const filedReading = await kept.json();
    expect(filedReading.pages.length).toBeGreaterThan(0);
    expect(filedReading.pages[0].text).toContain(PAGE_WORDS);
    expect(Object.keys(filedReading.extracted).length).toBeGreaterThan(0);

    const reviewer = await apiAs(playwright, baseURL!, userByRole('rev').email);
    const denied = await api.get(`/api/intake/documents/${doc.id}/reading`, {
      headers: reviewer.headers,
    });
    expect(denied.status()).toBe(401);
    const deniedEdrms = await api.get(
      `/api/documents/${doc.documentId}/reading`,
      {headers: reviewer.headers},
    );
    expect(deniedEdrms.status()).toBe(401);
    // the back-fill route of the EDRMS takes intake's token only
    const putText = await api.put(
      `/api/documents/${doc.documentId}/transcription`,
      {headers: reviewer.headers, data: {pages: [{page: 1, text: 'x'}]}},
    );
    expect(putText.status()).toBe(401);
    await reviewer.dispose();
    await api.dispose();

    // with E2E_DB=postgres the EDRMS stores files in a folder: the text is there, encrypted
    const folder = join(
      STACK_DIR,
      'files',
      'edrms',
      'edrms',
      doc.documentId,
      'v1',
    );
    test.skip(
      !existsSync(folder),
      'files are kept in memory; run with E2E_DB=postgres to store them in folders',
    );
    const texts = readdirSync(folder).filter(n =>
      n.startsWith('transcription-'),
    );
    expect(texts).toHaveLength(1);
    const bytes = readFileSync(join(folder, texts[0]));
    if (E2E_BAO !== 'off') {
      expect(bytes.subarray(0, 4).toString()).toBe('LRFE');
      expect(bytes.includes(Buffer.from(PAGE_WORDS))).toBe(false);
    }
  },
);

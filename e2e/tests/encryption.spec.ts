/**
 * Stored files are encrypted (API-640), in every run unless E2E_BAO=off (API-795); the other specs
 * run unchanged on top of it (the deed workflow: capture, review, file, view, integrity, correction).
 *
 *   E2E_BAO=real     a throwaway OpenBao (stack/start-backend.mjs): each service's AppRole may use only
 *                    its own key, checked against the real vault
 *   E2E_DB=postgres  files are stored in folders under .stack/files: every stored file is ciphertext
 *   E2E_BAO=docker   the containers' OpenBao (npm run test:docker): every file in the services'
 *                    volumes is ciphertext
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, statSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import {BAO_DIR, E2E_BAO, PORTS, STACK_DIR} from '../stack/config.mjs';
import {signedInPage} from '../support/auth';
import {userByRole} from '../support/catalogue';
import {apiAs, filedDocument} from '../support/intake';
import {openInDocuments} from '../support/documents';
import {evidence} from '../support/evidence';

const MODE = E2E_BAO;
const tag = {tag: '@API-640'};
test.skip(MODE === 'off', 'files are stored plain with E2E_BAO=off');

const AUDITOR = userByRole('aud');
const BAO = `http://127.0.0.1:${PORTS.bao}`;

/** AppRole login to the throwaway OpenBao, as the given service. */
async function loginAs(
  service: 'edrms' | 'intake' | 'extracts',
): Promise<string> {
  const read = (f: string) =>
    readFileSync(join(BAO_DIR, 'approle', f), 'utf8').trim();
  const res = await fetch(`${BAO}/v1/auth/approle/login`, {
    method: 'POST',
    body: JSON.stringify({
      role_id: read(`${service}-role-id`),
      secret_id: read(`${service}-secret-id`),
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).auth.client_token;
}
const dataKey = (token: string, key: string) =>
  fetch(`${BAO}/v1/transit/datakey/plaintext/${key}`, {
    method: 'POST',
    headers: {'X-Vault-Token': token},
    body: JSON.stringify({bits: 256}),
  }).then(r => r.status);

test('each service may use only its own key in the vault', tag, async () => {
  test.skip(MODE !== 'real', 'needs the real OpenBao (E2E_BAO=real)');
  const edrms = await loginAs('edrms');
  const intake = await loginAs('intake');
  expect(await dataKey(edrms, 'edrms-files')).toBe(200);
  expect(await dataKey(intake, 'intake-files')).toBe(200);
  expect(await dataKey(intake, 'edrms-files')).toBe(403);
  expect(await dataKey(edrms, 'intake-files')).toBe(403);
  // the extracts service: its stored PDFs' key only (API-780)
  const extracts = await loginAs('extracts');
  expect(await dataKey(extracts, 'extracts-files')).toBe(200);
  expect(await dataKey(extracts, 'edrms-files')).toBe(403);
  expect(await dataKey(edrms, 'extracts-files')).toBe(403);
});

test(
  'a record filed from an encrypted scan opens as the original and its integrity is verified',
  tag,
  async ({browser, playwright, baseURL}) => {
    const doc = await filedDocument(playwright, baseURL!, browser);

    // the file served to the viewer is the original: its SHA-256 matches the sealed version's
    const aud = await apiAs(playwright, baseURL!, AUDITOR.email);
    const record = await (
      await aud.api.get(`/api/documents/${doc.documentId}`, {
        headers: aud.headers,
      })
    ).json();
    expect(JSON.stringify(record)).not.toMatch(
      /encryption|wrappedKey|vault:v1:|fake:v1:/,
    );
    const link = await (
      await aud.api.get(`/api/documents/${doc.documentId}/content`, {
        headers: aud.headers,
      })
    ).json();
    expect(link.url).toMatch(/^\/api\/document-content\//);
    const file = await (await aud.api.get(link.url)).body();
    expect(file.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(file).digest('hex')).toBe(
      record.versions[0].sha256,
    );
    await aud.dispose();

    // the auditor checks it in the browser
    const page = await signedInPage(browser, AUDITOR.email, '/documents');
    await openInDocuments(page, doc.edrmsNo);
    await page
      .getByRole('button', {name: 'Check integrity', exact: true})
      .click();
    await expect(page.locator('.banner.ok')).toContainText(
      'Integrity verified · version 1.0',
    );
    await evidence(
      page,
      'API-640',
      `Auditor: a record stored encrypted (${MODE === 'fake' ? 'test keys' : 'keys from OpenBao'}) opens and its integrity is verified`,
    );
    await page.context().close();
  },
);

test(
  'every stored file is ciphertext',
  tag,
  async ({browser, playwright, baseURL}) => {
    const root = join(STACK_DIR, 'files');
    test.skip(
      MODE !== 'docker' && !existsSync(root),
      'files are kept in memory; run with E2E_DB=postgres to store them in folders',
    );
    await filedDocument(playwright, baseURL!, browser); // at least one scan and one record
    for (const service of ['intake', 'edrms']) {
      const files =
        MODE === 'docker'
          ? volumeFiles(service)
          : folderFiles(join(root, service));
      expect(files.length, service).toBeGreaterThan(0);
      for (const {name, bytes} of files) {
        expect(bytes.subarray(0, 4).toString(), name).toBe('LRFE');
        expect(bytes.includes(Buffer.from('%PDF')), name).toBe(false);
      }
    }
  },
);

/** A stored file: its path and contents. */
interface StoredFile {
  name: string;
  bytes: Buffer;
}

/** Every file in a folder of the tests' own stack, recursively. */
function folderFiles(dir: string): StoredFile[] {
  return readdirSync(dir).flatMap(n => {
    const path = join(dir, n);
    return statSync(path).isDirectory()
      ? folderFiles(path)
      : [{name: path, bytes: readFileSync(path)}];
  });
}

/** Every file in a service's volume in the test containers (compose project lrfe-e2e). */
function volumeFiles(service: string): StoredFile[] {
  const container = `lrfe-e2e-${service}-1`;
  const names = execFileSync(
    'docker',
    ['exec', container, 'find', `/data/${service}`, '-type', 'f'],
    {encoding: 'utf8'},
  )
    .split('\n')
    .filter(Boolean);
  return names.map(name => ({
    name: `${container}:${name}`,
    bytes: execFileSync('docker', ['exec', container, 'cat', name], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  }));
}

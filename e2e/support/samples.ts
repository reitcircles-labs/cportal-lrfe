/**
 * Filing the testers' sample documents through the API, with what the reviewer corrects while
 * verifying them, so a test can start from documents in the EDRMS.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect} from '@playwright/test';
import {userByRole} from './catalogue';
import {apiAs} from './intake';
import {REPO_DIR} from '../stack/config.mjs';

const SAMPLES = join(REPO_DIR, 'angular-app', 'docs', 'samples');

/**
 * Upload a sample as the scan operator and file it as the reviewer: `corrections` typed in, the rest
 * accepted as read. `as`: another file name (the canned AI reads its deed number from it), and
 * `reviewer`: who files it (default the demo reviewer).
 */
export async function fileSample(
  playwright: Parameters<typeof apiAs>[0],
  baseURL: string,
  file: string,
  corrections: Record<string, string> = {},
  {
    as: name = file,
    reviewer,
  }: {
    as?: string;
    reviewer?: () => Promise<{
      api: import('@playwright/test').APIRequestContext;
      headers: Record<string, string>;
      dispose: () => Promise<void>;
    }>;
  } = {},
): Promise<string> {
  const scan = await apiAs(playwright, baseURL, userByRole('scan').email);
  const batch = await (
    await scan.api.post('/api/intake/batches', {
      headers: scan.headers,
      data: {source: 'Tester samples'},
    })
  ).json();
  const up = await scan.api.post(`/api/intake/batches/${batch.id}/documents`, {
    // under another name, another file (a comment line appended), as intake refuses a scan it has seen before
    headers: scan.headers,
    multipart: {
      file: {
        name,
        mimeType: 'application/pdf',
        buffer:
          name === file
            ? readFileSync(join(SAMPLES, file))
            : Buffer.concat([
                readFileSync(join(SAMPLES, file)),
                Buffer.from(`\n% ${name}\n`),
              ]),
      },
    },
  });
  expect(up.status(), await up.text()).toBe(201);
  const {id} = await up.json();
  await expect
    .poll(
      async () =>
        (
          await (
            await scan.api.get(`/api/intake/documents/${id}`, {
              headers: scan.headers,
            })
          ).json()
        ).status,
      {timeout: 30_000},
    )
    .toBe('ready');
  await scan.dispose();

  const rev = reviewer
    ? await reviewer()
    : await apiAs(playwright, baseURL, userByRole('rev').email);
  const h = {headers: rev.headers};
  await expect
    .poll(
      async () =>
        (await rev.api.post(`/api/intake/documents/${id}/claim`, h)).status(),
      {timeout: 20_000},
    )
    .toBe(200);
  for (const [k, value] of Object.entries(corrections)) {
    const res = await rev.api.put(`/api/intake/documents/${id}/fields/${k}`, {
      ...h,
      data: {value},
    });
    expect(res.status(), `${k}: ${await res.text()}`).toBe(200);
  }
  await rev.api.post(`/api/intake/documents/${id}/accept-clean`, h);
  const detail = await (
    await rev.api.get(`/api/intake/documents/${id}`, h)
  ).json();
  for (const f of detail.fields.filter(
    (x: {status: string}) => x.status === 'pending',
  )) {
    await rev.api.put(`/api/intake/documents/${id}/fields/${f.k}`, {
      ...h,
      data: {status: 'accepted'},
    });
  }
  const filed = await rev.api.post(`/api/intake/documents/${id}/file`, h);
  expect(filed.status(), await filed.text()).toBe(200);
  const {edrmsNo} = await filed.json();
  await rev.dispose();
  return edrmsNo;
}

/**
 * The canned AI's deed, or bond, under the number `no` ("T 1234/2026", "B 77/2026": read from the
 * file name), filed with the reviewer's `corrections`. Its prior title is a neutral one unless given,
 * so it does not continue the chain of the shared Erf 1873 record (API-766 would flag that record).
 */
export function fileNumbered(
  playwright: Parameters<typeof apiAs>[0],
  baseURL: string,
  no: string,
  corrections: Record<string, string> = {},
): Promise<string> {
  const [, num, year] = /^([TB]) (\d+)\/(\d{4})$/.exec(no)!.slice(1);
  const name = no.startsWith('B')
    ? `B-${num}-${year}-mortgage-bond.pdf`
    : `deed-T${num}-${year}.pdf`;
  return fileSample(
    playwright,
    baseURL,
    '04-T-2210-2008-deed-of-transfer.pdf',
    {priorTitle: 'T 1/1900', ...corrections},
    {as: name},
  );
}

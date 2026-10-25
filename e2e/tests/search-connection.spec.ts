/**
 * The search service (API-802, API-808): only with E2E_DOCKER=1 (npm run test:docker), where it
 * and a throwaway search engine run as containers. It receives intake's and edrms' four document
 * events (read by the AI, rejected, filed, corrected) and fetches each document with its own
 * token; stopped while documents are uploaded and filed, it catches up once started again; its
 * lag is in its health. It writes each document into the index: searchable once the AI has read
 * it, marked as in intake; filing adds the corrected values to the same entry; a rejected upload
 * disappears; "re-index since" fills a gap. The engine has no port on the host: the tests ask it
 * from inside the search service's container, with its login. One file, run in order: a test
 * stops the container.
 */
import {spawnSync} from 'node:child_process';
import {expect, test} from '@playwright/test';
import {ENROLLED_USERS, userByRole} from '../support/catalogue';
import {apiAs, filedDocument, readyDocument} from '../support/intake';

test.skip(
  !process.env.E2E_DOCKER,
  'only against the containers (npm run test:docker)',
);
// a test stops the search service: not while another one uses it
test.describe.configure({mode: 'serial'});

const tag = {tag: '@API-802'};
const indexing = {tag: '@API-808'};
/** A reviewer other than the one who requests a correction: the approver. */
const SECOND = ENROLLED_USERS.find(
  u =>
    u.roles.length === 1 &&
    u.roles[0] === 'rev' &&
    u.email !== userByRole('rev').email,
)!;

/** Runs docker with these arguments; its output, or a failed test. */
function docker(...args: string[]): string {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(r.status, `docker ${args.join(' ')}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

/** The search service's container in the e2e project, running or not. */
function container(): string {
  const id = docker(
    'ps',
    '-aq',
    '--filter',
    'label=com.docker.compose.project=lrfe-e2e',
    '--filter',
    'label=com.docker.compose.service=search',
  ).trim();
  expect(id, 'the search container').toBeTruthy();
  return id;
}

interface Consumer {
  event: string;
  fetched: number;
  pending: number | null;
  unacked: number | null;
}
interface Health {
  lag: number | null;
  consumers: Consumer[];
}

/** GET /health/events inside the container (the service has no port on the host); null when down. */
function health(): Health | null {
  const r = spawnSync(
    'docker',
    [
      'exec',
      container(),
      'node',
      '-e',
      "fetch('http://localhost:3508/health/events').then(r => r.text()).then(t => console.log(t))",
    ],
    {encoding: 'utf8'},
  );
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** The events the service fetched this document for, from its log (JSON lines). */
function fetchedFor(documentId: string): string[] {
  return docker('logs', container())
    .split('\n')
    .filter(line => line.includes(documentId))
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(l => l?.msg === 'search: document fetched')
    .map(l => l.event);
}

/** Waits until the service has fetched the document for each of these events. */
async function expectFetched(documentId: string, events: string[]) {
  await expect
    .poll(() => fetchedFor(documentId), {timeout: 30_000})
    .toEqual(expect.arrayContaining(events));
}

/** A filed document's correction, requested by the reviewer and approved by a second one. */
async function correct(
  playwright: Parameters<typeof apiAs>[0],
  baseURL: string,
  documentId: string,
) {
  const rev = await apiAs(playwright, baseURL, userByRole('rev').email);
  const document = await (
    await rev.api.get(`/api/documents/${documentId}`, {headers: rev.headers})
  ).json();
  const field = document.fields[0];
  const started = await rev.api.post(
    '/api/processes/document-amendment/instances',
    {
      headers: rev.headers,
      data: {
        variables: {
          documentId,
          expectedVersion: document.currentVersion,
          reason: 'e2e: the search service sees corrections',
          changes: [{k: field.k, v: `${field.v} 2`}],
        },
      },
    },
  );
  expect(started.status(), await started.text()).toBe(201);
  await rev.dispose();

  const approver = await apiAs(playwright, baseURL, SECOND.email);
  let task: {id: string} | undefined;
  await expect
    .poll(
      async () => {
        const {tasks} = await (
          await approver.api.get('/api/tasks', {headers: approver.headers})
        ).json();
        task = tasks.find((t: {title?: string}) =>
          (t.title ?? '').includes(document.edrmsNo),
        );
        return !!task;
      },
      {timeout: 20_000},
    )
    .toBe(true);
  const done = await approver.api.post(`/api/tasks/${task!.id}/complete`, {
    headers: approver.headers,
    data: {output: {outcome: 'approved'}},
  });
  expect(done.status(), await done.text()).toBe(200);
  await approver.dispose();
}

// the search service starts after the search engine: it answers before the first test
test.beforeAll(async () => {
  await expect.poll(() => health(), {timeout: 120_000}).not.toBeNull();
});

test(
  'the search service receives the four events and fetches each document from intake or the EDRMS',
  tag,
  async ({browser, playwright, baseURL}) => {
    // read by the AI, then rejected
    const rejected = await readyDocument(playwright, baseURL!, browser);
    const rev = await apiAs(playwright, baseURL!, userByRole('rev').email);
    const res = await rev.api.post(
      `/api/intake/documents/${rejected.id}/reject`,
      {headers: rev.headers, data: {reason: 'e2e: not a deed'}},
    );
    expect(res.status(), await res.text()).toBe(200);
    await rev.dispose();
    await expectFetched(rejected.id, [
      'intake.document.extracted',
      'intake.document.rejected',
    ]);

    // read by the AI, filed, then corrected
    const filed = await filedDocument(playwright, baseURL!, browser);
    await expectFetched(filed.id, ['intake.document.extracted']);
    await expectFetched(filed.documentId, ['edrms.document.filed']);
    await correct(playwright, baseURL!, filed.documentId);
    await expectFetched(filed.documentId, [
      'edrms.document.filed',
      'edrms.document.amended',
    ]);

    // nothing left to handle: no lag
    await expect.poll(() => health()?.lag, {timeout: 30_000}).toBe(0);
    expect(health()!.consumers.map(c => c.event)).toEqual([
      'intake.document.extracted',
      'intake.document.rejected',
      'edrms.document.filed',
      'edrms.document.amended',
    ]);
  },
);

test(
  'stopped while documents are uploaded and filed, the search service catches up once started; its lag is in its health',
  tag,
  async ({browser, playwright, baseURL}) => {
    docker('stop', container());
    try {
      const doc = await filedDocument(playwright, baseURL!, browser);
      docker('start', container());
      await expectFetched(doc.id, ['intake.document.extracted']);
      await expectFetched(doc.documentId, ['edrms.document.filed']);
      await expect.poll(() => health()?.lag, {timeout: 30_000}).toBe(0);
    } finally {
      // the other tests find it running, whatever happened here
      docker('start', container());
    }
  },
);

/** A script run in the search service's folder, with `engine` (its login) and `INDEX_ALIAS`. */
function inSearch(body: string): unknown {
  const script = `
    import {createEngine} from './src/engine.js';
    import {INDEX_ALIAS, buildSearchQuery, loadCountryPack} from '@lrfe/search-index';
    const engine = createEngine({url: process.env.OPENSEARCH_URL, loginDir: process.env.OPENSEARCH_LOGIN_DIR});
    const out = await (async () => { ${body} })();
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const out = docker(
    'exec',
    container(),
    'node',
    '--input-type=module',
    '-e',
    script,
  );
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

interface Entry {
  found: boolean;
  version?: number;
  source?: {
    status: string;
    reference: string[];
    edrmsNo?: string;
    access: {audience: string};
    shown: {fields: Array<{k: string; v: string}>};
  };
}

/** The document's entry in the index, as it is now. */
function entry(id: string): Entry {
  return inSearch(`
    const res = await engine('GET', '/' + INDEX_ALIAS + '/_doc/' + ${JSON.stringify(id)});
    return {found: !!res.body?.found, version: res.body?._version, source: res.body?._source};
  `) as Entry;
}

/** The ids the index finds for what was typed. */
function found(q: string): string[] {
  return inSearch(`
    await engine('POST', '/' + INDEX_ALIAS + '/_refresh');
    const query = buildSearchQuery(${JSON.stringify(q)}, loadCountryPack('NA'), {size: 200});
    const res = await engine('POST', '/' + INDEX_ALIAS + '/_search', query);
    return res.body.hits.hits.map(h => h._id);
  `) as string[];
}

test(
  'an upload is searchable within seconds of the AI reading, marked as in intake; filing adds the corrected values to the same entry',
  indexing,
  async ({browser, playwright, baseURL}) => {
    await expect.poll(() => health(), {timeout: 60_000}).not.toBeNull();
    const doc = await readyDocument(playwright, baseURL!, browser);
    await expect.poll(() => entry(doc.id).found, {timeout: 15_000}).toBe(true);
    const inIntake = entry(doc.id).source!;
    expect(inIntake.status).toBe('intake');
    expect(inIntake.access.audience).toBe('intake');
    const reference = inIntake.reference[0];
    expect(found(reference)).toContain(doc.id);

    const filed = await filedDocument(playwright, baseURL!, browser);
    await expect
      .poll(() => entry(filed.id).source?.status, {timeout: 15_000})
      .toBe('filed');
    const entryFiled = entry(filed.id).source!;
    expect(entryFiled.edrmsNo).toBe(filed.edrmsNo);
    expect(entryFiled.access.audience).toBe('edrms');
    // one entry, keyed by the upload, found by its EDRMS number
    expect(found(filed.edrmsNo)).toEqual([filed.id]);
  },
);

test(
  'a rejected upload disappears from the index',
  indexing,
  async ({browser, playwright, baseURL}) => {
    await expect.poll(() => health(), {timeout: 60_000}).not.toBeNull();
    const doc = await readyDocument(playwright, baseURL!, browser);
    await expect.poll(() => entry(doc.id).found, {timeout: 15_000}).toBe(true);
    const rev = await apiAs(playwright, baseURL!, userByRole('rev').email);
    const res = await rev.api.post(`/api/intake/documents/${doc.id}/reject`, {
      headers: rev.headers,
      data: {reason: 'e2e: not a deed'},
    });
    expect(res.status(), await res.text()).toBe(200);
    await rev.dispose();
    await expect.poll(() => entry(doc.id).found, {timeout: 15_000}).toBe(false);
  },
);

test(
  '"re-index since" fills a gap: an entry lost from the index is written again',
  indexing,
  async ({browser, playwright, baseURL}) => {
    await expect.poll(() => health(), {timeout: 60_000}).not.toBeNull();
    const since = new Date().toISOString();
    const filed = await filedDocument(playwright, baseURL!, browser);
    await expect
      .poll(() => entry(filed.id).source?.status, {timeout: 15_000})
      .toBe('filed');
    // the entry is lost (as after a restore of an older backup)
    const {version} = entry(filed.id);
    inSearch(`
      return (await engine('DELETE', '/' + INDEX_ALIAS + '/_doc/' + ${JSON.stringify(filed.id)} +
        '?version=' + ${version} + '&version_type=external_gte')).status;
    `);
    expect(entry(filed.id).found).toBe(false);

    const out = docker(
      'exec',
      container(),
      'node',
      'src/reindex.js',
      '--since',
      since,
    );
    const results = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(results.indexed).toBeGreaterThan(0);
    expect(entry(filed.id).source?.status).toBe('filed');
  },
);

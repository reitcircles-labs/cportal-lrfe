/**
 * The search service's connection (API-802): only with E2E_DOCKER=1 (npm run test:docker), where
 * it runs as its container. It receives intake's and edrms' four document events (read by the AI,
 * rejected, filed, corrected) and fetches each document with its own token; stopped while
 * documents are uploaded and filed, it catches up once started again; its lag is in its health.
 * What it fetched is only logged until the index is written (API-808): the tests read its log.
 */
import {spawnSync} from 'node:child_process';
import {expect, test} from '@playwright/test';
import {ENROLLED_USERS, userByRole} from '../support/catalogue';
import {apiAs, filedDocument, readyDocument} from '../support/intake';

test.skip(
  !process.env.E2E_DOCKER,
  'only against the containers (npm run test:docker)',
);
// the second test stops the search service: not while the first one waits for it
test.describe.configure({mode: 'serial'});

const tag = {tag: '@API-802'};
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

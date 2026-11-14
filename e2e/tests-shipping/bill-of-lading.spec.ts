/**
 * A bill of lading through the whole platform (CB-28), on the shipping product's stack (npm run
 * test:shipping, API only): a B/L clerk stores a draft from DCSA's own example, changes it and
 * submits it; the commit is made as the workflow service makes it, by a second clerk (four eyes);
 * the audit trail holds the B/L's events with the acting organisation, and the committed version's
 * proof verifies, on the platform and with the offline verifier. Everything goes through the
 * gateway. The users are the shipping pack's demo users, signed in here (no land catalogue).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect, test, type APIRequestContext} from '@playwright/test';
import {
  demoEmails,
  serviceToken,
  signIn,
  type SignedIn,
} from '../support/shipping';
import {GATEWAY_URL, REPO_DIR} from '../stack/config.mjs';

/** The B/L format every call here uses. */
const FORMAT = 'dcsa-3.0';

/** A trail entry, as far as these tests read it. */
interface TrailEntry {
  type: string;
  source: string;
  actor: {id: string | null; org?: string | null};
}

/**
 * DCSA's example transport document, as DCSA writes it (with its status).
 * @param file the example's file name
 * @return the document
 */
function dcsaExample(file = 'td-regular.json'): Record<string, unknown> {
  const path = join(
    REPO_DIR,
    'backend',
    'domains',
    'shipping',
    'dcsa',
    '3.0.3',
    'examples',
    file,
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}

test.describe.configure({mode: 'serial'});

test.describe('a bill of lading on the shipping product (CB-28)', () => {
  let api: APIRequestContext;
  let clerk: SignedIn;
  let secondClerk: SignedIn;
  let admin: SignedIn;
  let recordId: string;

  test.beforeAll(async ({playwright}) => {
    api = await playwright.request.newContext({baseURL: GATEWAY_URL});
    const [first, second] = demoEmails('bld');
    clerk = await signIn(api, first);
    secondClerk = await signIn(api, second);
    admin = await signIn(api, demoEmails('adm')[0]);
    expect(clerk.organisationId).toBeTruthy();
    expect(secondClerk.organisationId).toBe(clerk.organisationId);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test("a B/L clerk stores a draft from DCSA's example as DCSA writes it, and reads it back", async () => {
    const example = dcsaExample();
    const created = await api.post('/api/records', {
      headers: clerk.headers,
      data: {format: FORMAT, document: example},
    });
    expect(created.status(), await created.text()).toBe(201);
    const record = await created.json();
    recordId = record.id;
    expect([
      record.recordNo,
      record.organisationId,
      record.draftVersion,
    ]).toEqual([example.transportDocumentReference, clerk.organisationId, 1]);

    const read = await api.get(`/api/records/${recordId}`, {
      headers: clerk.headers,
    });
    expect(read.status(), await read.text()).toBe(200);
    // the model keeps DCSA's document without its status, which the platform's states replace
    const {transportDocumentStatus, ...withoutStatus} = example;
    expect(transportDocumentStatus).toBe('DRAFT');
    expect((await read.json()).draft.data.document).toEqual(withoutStatus);
  });

  test('a B/L without containers is refused, naming the containers (400)', async () => {
    const document = {
      ...dcsaExample(),
      transportDocumentReference: 'CB28NOCONTAINERS',
      utilizedTransportEquipments: [],
    };
    const res = await api.post('/api/records', {
      headers: clerk.headers,
      data: {format: FORMAT, document},
    });
    expect(res.status(), await res.text()).toBe(400);
    const {problems} = (await res.json()).details;
    const messages = problems.map((p: {message: string}) => p.message);
    expect(messages.join(' ')).toContain('containers');
  });

  test('the clerk changes the draft and submits it; the workflow commits it with a second clerk', async () => {
    const changed = {
      ...dcsaExample(),
      termsAndConditions: 'Changed by the clerk before submitting (CB-28).',
    };
    const saved = await api.put(`/api/records/${recordId}/draft`, {
      headers: clerk.headers,
      data: {format: FORMAT, document: changed},
    });
    expect(saved.status(), await saved.text()).toBe(200);
    expect((await saved.json()).draft.data.document.termsAndConditions).toBe(
      changed.termsAndConditions,
    );

    const submitted = await api.post(
      `/api/records/${recordId}/versions/1/submit`,
      {headers: clerk.headers},
    );
    expect(submitted.status(), await submitted.text()).toBe(200);
    expect((await submitted.json()).draftState).toBe('in_review');

    // the review decision, reported as the workflow service reports it, through the gateway
    const asWorkflow = {authorization: `Bearer ${serviceToken('bpm')}`};
    const commitBy = (user: SignedIn) =>
      api.post(`/api/records/${recordId}/versions/1/commit`, {
        headers: asWorkflow,
        data: {by: {id: user.id, name: user.name}},
      });
    // four eyes: the person who submitted it cannot commit it
    const own = await commitBy(clerk);
    expect(own.status(), await own.text()).toBe(403);
    const committed = await commitBy(secondClerk);
    expect(committed.status(), await committed.text()).toBe(200);
    const record = await committed.json();
    expect([record.status, record.currentVersion]).toEqual(['committed', 1]);
    expect(record.current.seal).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the second clerk of the organisation reads it; a user without the permission gets 403', async () => {
    const second = await api.get(`/api/records/${recordId}`, {
      headers: secondClerk.headers,
    });
    expect(second.status(), await second.text()).toBe(200);
    expect((await second.json()).currentVersion).toBe(1);

    const versions = await api.get(`/api/records/${recordId}/versions`, {
      headers: secondClerk.headers,
    });
    expect(versions.status(), await versions.text()).toBe(200);

    // the administrator has no B/L permission
    for (const path of [
      '/api/records',
      `/api/records/${recordId}`,
      `/api/records/${recordId}/versions/1`,
    ]) {
      const res = await api.get(path, {headers: admin.headers});
      expect(res.status(), `${path}: ${await res.text()}`).toBe(403);
    }
  });

  test("the audit trail holds the B/L's events with the acting organisation, and the committed version's proof verifies", async () => {
    test.setTimeout(90_000);
    const trail = async (query = ''): Promise<TrailEntry[]> => {
      const res = await api.get(
        `/api/audit/trail?subject=record:${recordId}${query}`,
        {headers: admin.headers},
      );
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()).entries;
    };
    const userEvents = [
      'records.record.created',
      'records.draft.changed',
      'records.draft.submitted',
    ];
    await expect
      .poll(async () => (await trail()).map(e => e.type), {timeout: 30_000})
      .toEqual([...userEvents, 'records.record.committed']);
    const entries = await trail();
    expect(new Set(entries.map(e => e.source))).toEqual(
      new Set(['shipping-records']),
    );
    for (const entry of entries.filter(e => userEvents.includes(e.type))) {
      expect([entry.actor.id, entry.actor.org], entry.type).toEqual([
        clerk.id,
        clerk.organisationId,
      ]);
    }
    const committed = entries.find(e => e.type === 'records.record.committed');
    expect(committed?.actor.id).toBe(secondClerk.id);
    // the trail of the organisation holds what its clerk did
    const ofOrganisation = await trail(`&org=${clerk.organisationId}`);
    expect(ofOrganisation.map(e => e.type)).toEqual(userEvents);

    // the committed version is a leaf of the tree, waiting for its batch
    const proofPath = `/api/audit/proofs/record-version/${recordId}?version=1`;
    await expect
      .poll(
        async () =>
          (await api.get(proofPath, {headers: admin.headers})).status(),
        {timeout: 30_000},
      )
      .toBe(200);

    // the test stack has no blockchain: the administrator makes the batch on the test chain
    const batch = await api.post('/api/audit/test/anchorings', {
      headers: admin.headers,
      data: {outcome: 'confirmed'},
    });
    expect(batch.status(), await batch.text()).toBe(201);

    // checked on the platform: the seal recomputed from the B/L, its path in the tree, the chain
    const verified = await api.post('/api/audit/verify', {
      headers: admin.headers,
      data: {kind: 'record-version', id: recordId, version: 1},
    });
    expect(verified.status(), await verified.text()).toBe(200);
    const check = await verified.json();
    expect(check.valid, JSON.stringify(check.checks)).toBe(true);
    expect(check.status).toBe('confirmed');

    // and with the offline verifier, as land-record.spec.ts checks a land record's proof
    const proofRes = await api.get(proofPath, {headers: admin.headers});
    expect(proofRes.status(), await proofRes.text()).toBe(200);
    const proof = await proofRes.json();
    expect([proof.format, proof.status]).toEqual([
      'lrfe-audit-proof/1',
      'confirmed',
    ]);
    const wallet = await (
      await fetch(`${GATEWAY_URL}/api/audit/anchoring/wallet`)
    ).json();
    const verifier = join(
      REPO_DIR,
      'backend',
      'services',
      'audit',
      'verifier',
      'lrfe-verify.mjs',
    );
    const {verifyProof} = await import(pathToFileURL(verifier).href);
    const result = await verifyProof(proof, {
      address: wallet.address,
      fetchImpl: (url: string, init: RequestInit) =>
        fetch(
          `${GATEWAY_URL}/api/audit/test/koios/${new URL(url).pathname.split('/').pop()}`,
          init,
        ),
    });
    expect(result.valid, JSON.stringify(result.checks)).toBe(true);
  });
});

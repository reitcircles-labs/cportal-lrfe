/**
 * Blank endorsement and transfer of possession through the gateway (CB-37), on the shipping
 * product's stack (npm run test:shipping, API only): the mixed journey, issue → the shipper
 * endorses in blank to bank A → bank A transfers to bank B → bank B endorses to the buyer by name
 * → the buyer surrenders → the carrier releases, each step run by a user of the organisation
 * that may run it. On the way, the refusals of CB-37: switching the blank-endorsed B/L to paper
 * without confirming it becomes a bearer document, a transfer by a past holder, a transfer to an
 * organisation that is not registered, and a transfer of the B/L once endorsed to a name. At the
 * end the six title events are on the audit trail, anchored on the test chain, and the title
 * proof (GET /records/:id/title/proof) verifies with the offline verifier.
 *
 * The carrier is the demo organisation (its two demo clerks, four eyes); the shipper, the banks
 * and the buyer are organisations made here by the administrator, each with a B/L clerk invited
 * through the API.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect, test, type APIRequestContext} from '@playwright/test';
import {unique} from '../support/admin';
import {
  demoEmails,
  organisationWithClerk,
  serviceToken,
  signIn,
  type Organisation,
  type SignedIn,
} from '../support/shipping';
import {TITLE_WORDING} from '../../backend/domains/shipping/src/title/wording.js';
import {GATEWAY_URL, REPO_DIR} from '../stack/config.mjs';

/** A chain-of-title entry, as far as these tests read it. */
interface ChainEntry {
  seq: number;
  command: string;
  from: string | null;
  to: string | null;
  endorsement: string;
  actor: {id: string; org: string};
}

/** The title of a B/L, as GET /records/:id/title answers it (the fields read here). */
interface TitleView {
  recordId: string;
  title: {
    state: string;
    holder: string | null;
    endorsement: string;
  } | null;
  allowedCommands: string[];
  chain: ChainEntry[];
}

/** A title proof bundle (lrfe-title-proof/1), as far as these tests read it. */
interface TitleProof {
  format: string;
  entries: ChainEntry[];
  anchor: {pending?: boolean; status?: string};
}

/** The title events of the mixed journey, in order. */
const MIXED_EVENTS = [
  'records.title.issue',
  'records.title.endorse',
  'records.title.transfer',
  'records.title.endorse',
  'records.title.surrender',
  'records.title.release',
];

/**
 * DCSA's example transport document (a B/L to order) with its own reference.
 * @param reference the transport document reference
 * @return the document
 */
function negotiableBl(reference: string): Record<string, unknown> {
  const path = join(
    REPO_DIR,
    'backend',
    'domains',
    'shipping',
    'dcsa',
    '3.0.3',
    'examples',
    'td-regular.json',
  );
  const example = JSON.parse(readFileSync(path, 'utf8'));
  return {...example, transportDocumentReference: reference};
}

/**
 * The verifier's blockchain queries, sent to the test chain behind the gateway instead: the
 * query's name (the last part of its path) is kept, the host is the gateway's.
 * @param url the address the verifier asks
 * @param init the request's options
 * @return the test chain's answer
 */
function testChainFetch(url: string, init: RequestInit): Promise<Response> {
  const query = new URL(url).pathname.split('/').pop();
  return fetch(`${GATEWAY_URL}/api/audit/test/koios/${query}`, init);
}

test.describe.configure({mode: 'serial'});

test.describe('blank endorsement and transfer through the gateway (CB-37)', () => {
  let api: APIRequestContext;
  let admin: SignedIn;
  let carrier: SignedIn;
  let approver: SignedIn;
  let shipper: Organisation;
  let bankA: Organisation;
  let bankB: Organisation;
  let buyer: Organisation;
  let recordId: string;

  /**
   * Runs a title command as a user: the raw answer.
   * @param name the command
   * @param user the caller
   * @param data the command's arguments
   * @return the answer
   */
  function command(name: string, user: SignedIn, data: object = {}) {
    return api.post(`/api/records/${recordId}/title/${name}`, {
      headers: user.headers,
      data,
    });
  }

  /**
   * Runs a title command expected to succeed: the title it answers.
   * @param name the command
   * @param user the caller
   * @param data the command's arguments
   * @return the title
   */
  async function run(
    name: string,
    user: SignedIn,
    data: object = {},
  ): Promise<TitleView> {
    const res = await command(name, user, data);
    expect(res.status(), `${name}: ${await res.text()}`).toBe(200);
    return res.json();
  }

  /**
   * Reads the B/L's title as a user.
   * @param user the caller
   * @return the title
   */
  async function read(user: SignedIn): Promise<TitleView> {
    const res = await api.get(`/api/records/${recordId}/title`, {
      headers: user.headers,
    });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }

  /**
   * Runs a command expected to be refused, and checks that nothing was recorded.
   * @param name the command
   * @param user the caller
   * @param data the command's arguments
   * @param status the expected status
   * @return the refusal's body
   */
  async function refused(
    name: string,
    user: SignedIn,
    data: object,
    status: number,
  ): Promise<{message: string; details?: {code?: string}}> {
    const before = (await read(carrier)).chain.length;
    const res = await command(name, user, data);
    expect(res.status(), `${name}: ${await res.text()}`).toBe(status);
    expect((await read(carrier)).chain).toHaveLength(before);
    return res.json();
  }

  test.beforeAll(async ({playwright}) => {
    test.setTimeout(120_000);
    api = await playwright.request.newContext({baseURL: GATEWAY_URL});
    admin = await signIn(api, demoEmails('adm')[0]);
    const [first, second] = demoEmails('bld');
    carrier = await signIn(api, first);
    approver = await signIn(api, second);
    shipper = await organisationWithClerk(api, admin, 'Shipper');
    bankA = await organisationWithClerk(api, admin, 'BankA');
    bankB = await organisationWithClerk(api, admin, 'BankB');
    buyer = await organisationWithClerk(api, admin, 'Buyer');
    const organisations = [
      carrier.organisationId,
      shipper.id,
      bankA.id,
      bankB.id,
      buyer.id,
    ];
    expect(new Set(organisations).size).toBe(5);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test("the carrier's B/L to order is committed with four eyes and issued to the shipper", async () => {
    const created = await api.post('/api/records', {
      headers: carrier.headers,
      data: {
        format: 'dcsa-3.0',
        document: negotiableBl(`CB37${unique().toUpperCase()}`.slice(0, 20)),
        partyOrganisations: {shipper: shipper.id},
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    recordId = (await created.json()).id;
    const submitted = await api.post(
      `/api/records/${recordId}/versions/1/submit`,
      {headers: carrier.headers},
    );
    expect(submitted.status(), await submitted.text()).toBe(200);
    const committed = await api.post(
      `/api/records/${recordId}/versions/1/commit`,
      {
        headers: {authorization: `Bearer ${serviceToken('bpm')}`},
        data: {by: {id: approver.id, name: approver.name}},
      },
    );
    expect(committed.status(), await committed.text()).toBe(200);

    const issued = await run('issue', carrier);
    expect(issued.title).toMatchObject({
      state: 'issued',
      holder: shipper.id,
      endorsement: 'none',
    });
  });

  test('the shipper endorses it in blank to bank A, who may transfer it or endorse it', async () => {
    const blank = await run('endorse', shipper.clerk, {
      to: bankA.id,
      inBlank: true,
    });
    expect(blank.title).toMatchObject({
      state: 'with-holder',
      holder: bankA.id,
      endorsement: 'blank',
    });
    const view = await read(bankA.clerk);
    expect(view.allowedCommands).toEqual(
      expect.arrayContaining(['endorse', 'transfer']),
    );
  });

  test('switching the blank-endorsed B/L to paper without confirming the bearer document is refused with the warning', async () => {
    for (const data of [{}, {confirmBearer: false}]) {
      const body = await refused('switch-to-paper', bankA.clerk, data, 409);
      expect(body.message).toBe(TITLE_WORDING.bearerUnconfirmed);
      expect(body.details?.code).toBe('bearer-unconfirmed');
    }
  });

  test('a transfer to an organisation that is not registered is refused; bank A transfers it to bank B', async () => {
    await refused(
      'transfer',
      bankA.clerk,
      {to: '00000000-0000-4000-8000-000000000000'},
      422,
    );
    const moved = await run('transfer', bankA.clerk, {to: bankB.id});
    expect(moved.title).toMatchObject({
      state: 'with-holder',
      holder: bankB.id,
      endorsement: 'blank',
    });
  });

  test('a past holder may no longer transfer it', async () => {
    const body = await refused('transfer', bankA.clerk, {to: buyer.id}, 403);
    expect(body.message).toBe(TITLE_WORDING.notHolder('transfer'));
  });

  test('bank B endorses it to the buyer by name; the buyer may not transfer it', async () => {
    const named = await run('endorse', bankB.clerk, {
      to: buyer.id,
      inBlank: false,
    });
    expect(named.title).toMatchObject({
      state: 'with-holder',
      holder: buyer.id,
      endorsement: 'named',
    });
    expect((await read(buyer.clerk)).allowedCommands).not.toContain('transfer');
    const body = await refused('transfer', buyer.clerk, {to: bankA.id}, 409);
    expect(body.message).toBe(TITLE_WORDING.notEndorsedInBlank('named'));
  });

  test('the buyer surrenders it and the carrier releases it: the chain of title holds the six steps', async () => {
    await run('surrender', buyer.clerk);
    const released = await run('release', carrier);
    expect(released.title).toMatchObject({state: 'accomplished', holder: null});
    expect(
      released.chain.map(e => [e.command, e.from, e.to, e.endorsement]),
    ).toEqual([
      ['issue', null, shipper.id, 'none'],
      ['endorse', shipper.id, bankA.id, 'blank'],
      ['transfer', bankA.id, bankB.id, 'blank'],
      ['endorse', bankB.id, buyer.id, 'named'],
      ['surrender', buyer.id, carrier.organisationId, 'named'],
      ['release', carrier.organisationId, null, 'named'],
    ]);
    expect(released.chain.map(e => e.actor.org)).toEqual([
      carrier.organisationId,
      shipper.id,
      bankA.id,
      bankB.id,
      buyer.id,
      carrier.organisationId,
    ]);
  });

  test('the audit trail holds the six title events and none for the refusals; they are anchored and the title proof verifies offline', async () => {
    test.setTimeout(120_000);
    const titleEvents = async () => {
      const res = await api.get(`/api/audit/trail?subject=record:${recordId}`, {
        headers: admin.headers,
      });
      expect(res.status(), await res.text()).toBe(200);
      const {entries} = await res.json();
      return entries
        .filter((e: {type: string}) => e.type.startsWith('records.title.'))
        .map((e: {type: string}) => e.type);
    };
    await expect.poll(titleEvents, {timeout: 30_000}).toEqual(MIXED_EVENTS);

    // the test stack has no blockchain: the administrator makes the batch on the test chain
    const batch = await api.post('/api/audit/test/anchorings', {
      headers: admin.headers,
      data: {outcome: 'confirmed'},
    });
    expect(batch.status(), await batch.text()).toBe(201);

    const proofOf = async (): Promise<TitleProof> => {
      const res = await api.get(`/api/records/${recordId}/title/proof`, {
        headers: buyer.clerk.headers,
      });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    };
    await expect
      .poll(async () => (await proofOf()).anchor.status, {timeout: 30_000})
      .toBe('confirmed');
    const bundle = await proofOf();
    expect(bundle.format).toBe('lrfe-title-proof/1');
    expect(bundle.entries.map(e => e.command)).toEqual([
      'issue',
      'endorse',
      'transfer',
      'endorse',
      'surrender',
      'release',
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
    const {verifyTitleProof} = await import(pathToFileURL(verifier).href);
    const result = await verifyTitleProof(bundle, {
      address: wallet.address,
      fetchImpl: testChainFetch,
    });
    expect(result.valid, JSON.stringify(result.checks)).toBe(true);
    expect(result.title).toMatchObject({
      seq: 6,
      holder: null,
      state: 'accomplished',
    });
  });
});

/**
 * Amendment and split into child B/Ls through the gateway (CB-35), on the shipping product's stack
 * (npm run test:shipping, API only). The carrier's B/L to order, with two containers, is issued
 * to the shipper and endorsed to the bank; the bank surrenders it for amendment and the carrier
 * amends its port of discharge (a new committed version, the bank holds it again, the chain
 * entry names the new hash). The bank surrenders it for amendment again and the carrier splits it
 * into two children, one per container, for two ports of discharge; a split whose cargo does not
 * add up is refused first. The parent is closed, each child is held by the bank, and a child's
 * title proof (with its parent's chain) verifies with the offline verifier once anchored. A
 * release naming part of a cargo is refused.
 *
 * The carrier is the demo organisation (its two demo clerks, four eyes); the shipper and the bank
 * are organisations made here by the administrator, each with a B/L clerk.
 */
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
import {
  CONTAINER_A,
  OTHER_PORT,
  PARENT_PORT,
  blWithCargo,
  splitBody,
  splitByContainer,
  twoContainerBl,
} from '../../backend/services/shipping-records/tests/split-documents.js';
import {GATEWAY_URL, REPO_DIR} from '../stack/config.mjs';

/** A chain-of-title entry, as far as these tests read it. */
interface ChainEntry {
  seq: number;
  command: string;
  from: string | null;
  to: string | null;
  documentHash: string;
  previousHash: string | null;
  entryHash: string;
}

/** The title of a B/L, as the title API answers it (the fields read here). */
interface TitleView {
  recordId: string;
  title: {
    state: string;
    holder: string | null;
    returnTo: string | null;
    issuedVersion: number;
    documentHash: string;
  } | null;
  allowedCommands: string[];
  chain: ChainEntry[];
  children?: Array<{recordId: string; recordNo: string}>;
}

/** A title proof bundle (lrfe-title-proof/1), as far as these tests read it. */
interface TitleProof {
  format: string;
  entries: ChainEntry[];
  anchor: {pending?: boolean; status?: string};
  parent?: {recordId: string; entries: ChainEntry[]};
}

/**
 * The verifier's blockchain queries, sent to the test chain behind the gateway instead.
 * @param url the address the verifier asks
 * @param init the request's options
 * @return the test chain's answer
 */
function testChainFetch(url: string, init: RequestInit): Promise<Response> {
  const query = new URL(url).pathname.split('/').pop();
  return fetch(`${GATEWAY_URL}/api/audit/test/koios/${query}`, init);
}

test.describe.configure({mode: 'serial'});

test.describe('amendment and split through the gateway (CB-35)', () => {
  let api: APIRequestContext;
  let admin: SignedIn;
  let carrier: SignedIn;
  let approver: SignedIn;
  let shipper: Organisation;
  let bank: Organisation;
  let reference: string;
  let recordId: string;
  let children: Array<{recordId: string; recordNo: string}>;

  /**
   * Runs a title command on a B/L as a user: the raw answer.
   * @param id the B/L
   * @param name the command
   * @param user the caller
   * @param data the command's arguments
   * @return the answer
   */
  function command(
    id: string,
    name: string,
    user: SignedIn,
    data: object = {},
  ) {
    return api.post(`/api/records/${id}/title/${name}`, {
      headers: user.headers,
      data,
    });
  }

  /**
   * Runs a title command expected to succeed: the title it answers.
   * @param id the B/L
   * @param name the command
   * @param user the caller
   * @param data the command's arguments
   * @return the title
   */
  async function run(
    id: string,
    name: string,
    user: SignedIn,
    data: object = {},
  ): Promise<TitleView> {
    const res = await command(id, name, user, data);
    expect(res.status(), `${name}: ${await res.text()}`).toBe(200);
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
    bank = await organisationWithClerk(api, admin, 'Bank');
    reference = `CB35${unique().toUpperCase()}`.slice(0, 18);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('the B/L with two containers is committed, issued to the shipper and endorsed to the bank', async () => {
    const created = await api.post('/api/records', {
      headers: carrier.headers,
      data: {
        format: 'dcsa-3.0',
        document: twoContainerBl(reference),
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
    await run(recordId, 'issue', carrier);
    const endorsed = await run(recordId, 'endorse', shipper.clerk, {
      to: bank.id,
      inBlank: false,
    });
    expect(endorsed.title).toMatchObject({
      state: 'with-holder',
      holder: bank.id,
    });
  });

  test('the bank surrenders it for amendment and the carrier amends the port of discharge: version 2, the bank holds it again', async () => {
    const held = await run(recordId, 'surrender-for-amendment', bank.clerk);
    expect(held.title).toMatchObject({
      state: 'amendment-requested',
      holder: carrier.organisationId,
      returnTo: bank.id,
    });
    const document = twoContainerBl(reference) as {
      transports: Record<string, unknown>;
    };
    const amended = await run(recordId, 'amend', carrier, {
      format: 'dcsa-3.0',
      document: {
        ...document,
        transports: {
          ...document.transports,
          portOfDischarge: {UNLocationCode: OTHER_PORT},
        },
      },
    });
    expect(amended.title).toMatchObject({
      state: 'with-holder',
      holder: bank.id,
      issuedVersion: 2,
    });
    const last = amended.chain.at(-1)!;
    expect([last.command, last.from, last.to]).toEqual([
      'amend',
      carrier.organisationId,
      bank.id,
    ]);
    expect(last.documentHash).toBe(amended.title!.documentHash);
    expect(last.documentHash).not.toBe(amended.chain[0].documentHash);

    const record = await api.get(`/api/records/${recordId}`, {
      headers: carrier.headers,
    });
    expect(record.status(), await record.text()).toBe(200);
    expect((await record.json()).currentVersion).toBe(2);
  });

  test('the bank surrenders it for amendment again; a split whose cargo does not add up is refused', async () => {
    await run(recordId, 'surrender-for-amendment', bank.clerk);
    const again = await command(
      recordId,
      'surrender-for-amendment',
      bank.clerk,
    );
    // Already with the carrier: the state is checked before the holder (title-states.md).
    expect(again.status(), await again.text()).toBe(409);
    expect((await again.json()).details?.code).toBe('wrong-state');
    const short = await command(
      recordId,
      'split',
      carrier,
      splitBody([
        blWithCargo(`${reference}-A`, {
          cargo: [{container: CONTAINER_A, packages: 400, weight: 12000}],
        }),
        blWithCargo(`${reference}-B`, {
          cargo: [{container: CONTAINER_A, packages: 1, weight: 1}],
        }),
      ]),
    );
    expect(short.status(), await short.text()).toBe(400);
    expect((await short.json()).details?.code).toBe('cargo-mismatch');
  });

  test('the carrier splits it into two children for two ports: the parent closed, each child held by the bank', async () => {
    const split = await run(
      recordId,
      'split',
      carrier,
      splitBody(splitByContainer(`${reference}-A`, `${reference}-B`)),
    );
    expect(split.title).toMatchObject({state: 'split', holder: null});
    expect(split.allowedCommands).toEqual([]);
    children = split.children!;
    expect(children.map(c => c.recordNo)).toEqual([
      `${reference}-A`,
      `${reference}-B`,
    ]);
    const splitEntry = split.chain.at(-1)!;
    expect(splitEntry.command).toBe('split');

    const ports: string[] = [];
    for (const child of children) {
      const title = await api.get(`/api/records/${child.recordId}/title`, {
        headers: bank.clerk.headers,
      });
      expect(title.status(), await title.text()).toBe(200);
      const view: TitleView = await title.json();
      expect(view.title).toMatchObject({state: 'with-holder', holder: bank.id});
      expect(view.chain).toHaveLength(1);
      expect(view.chain[0].previousHash).toBe(splitEntry.entryHash);

      const record = await api.get(`/api/records/${child.recordId}`, {
        headers: carrier.headers,
      });
      expect(record.status(), await record.text()).toBe(200);
      const body = await record.json();
      ports.push(
        body.current.data.document.transports.portOfDischarge.UNLocationCode,
      );
    }
    expect(ports).toEqual([PARENT_PORT, OTHER_PORT]);

    const closed = await command(recordId, 'release', carrier);
    expect(closed.status(), await closed.text()).toBe(409);
  });

  test('a release naming part of the cargo is refused; the child stays with its holder', async () => {
    const child = children[0].recordId;
    await run(child, 'surrender', bank.clerk);
    const partial = await command(child, 'release', carrier, {
      containers: [CONTAINER_A],
    });
    expect(partial.status(), await partial.text()).toBe(400);
    expect((await partial.json()).details?.code).toBe('partial-release');
  });

  test("the child's title events are anchored and its title proof, with the parent's chain, verifies offline", async () => {
    test.setTimeout(120_000);
    const child = children[1];
    const titleEvents = async () => {
      const res = await api.get(
        `/api/audit/trail?subject=record:${child.recordId}`,
        {headers: admin.headers},
      );
      expect(res.status(), await res.text()).toBe(200);
      const {entries} = await res.json();
      return entries
        .filter((e: {type: string}) => e.type.startsWith('records.title.'))
        .map((e: {type: string}) => e.type);
    };
    await expect
      .poll(titleEvents, {timeout: 30_000})
      .toEqual(['records.title.issue-from-split']);

    const batch = await api.post('/api/audit/test/anchorings', {
      headers: admin.headers,
      data: {outcome: 'confirmed'},
    });
    expect(batch.status(), await batch.text()).toBe(201);

    const proofOf = async (): Promise<TitleProof> => {
      const res = await api.get(`/api/records/${child.recordId}/title/proof`, {
        headers: bank.clerk.headers,
      });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    };
    await expect
      .poll(async () => (await proofOf()).anchor.status, {timeout: 30_000})
      .toBe('confirmed');
    const bundle = await proofOf();
    expect(bundle.format).toBe('lrfe-title-proof/1');
    expect(bundle.parent?.recordId).toBe(recordId);
    expect(bundle.parent?.entries.at(-1)?.command).toBe('split');

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
      seq: 1,
      holder: bank.id,
      state: 'with-holder',
    });

    const {parent, ...withoutParent} = bundle;
    expect(parent).toBeDefined();
    const alone = await verifyTitleProof(withoutParent, {
      address: wallet.address,
      fetchImpl: testChainFetch,
    });
    expect(alone.valid).toBe(false);
  });
});

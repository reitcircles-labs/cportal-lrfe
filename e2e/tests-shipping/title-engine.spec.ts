/**
 * The title engine through the gateway (CB-34), on the shipping product's stack (npm run
 * test:shipping, API only): the negotiable journey of the blueprint, issue → endorse to the bank →
 * the bank endorses to the buyer → the buyer surrenders → the carrier releases, each step run by a
 * user of the organisation that may run it, the organisation taken from their session. A past
 * holder's endorsement is refused (403, with the reason) and an organisation outside the B/L does
 * not see it (404); the audit trail holds the five title events and nothing for the refusals.
 *
 * The carrier is the demo organisation (its two demo clerks, four eyes); the shipper, the bank,
 * the buyer and an outsider are organisations made here by the administrator, each with a B/L
 * clerk invited through the API.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
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
import {GATEWAY_URL, REPO_DIR} from '../stack/config.mjs';

/** The title of a B/L, as GET /records/:id/title answers it (the fields read here). */
interface TitleView {
  recordId: string;
  title: {
    kind: string;
    state: string;
    carrier: string;
    holder: string | null;
    endorsement: string;
  } | null;
  allowedCommands: string[];
  chain: Array<{
    seq: number;
    command: string;
    from: string | null;
    to: string | null;
    actor: {id: string; org: string};
  }>;
}

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

test.describe.configure({mode: 'serial'});

test.describe('the title engine through the gateway (CB-34)', () => {
  let api: APIRequestContext;
  let admin: SignedIn;
  let carrier: SignedIn;
  let approver: SignedIn;
  let shipper: Organisation;
  let bank: Organisation;
  let buyer: Organisation;
  let outsider: Organisation;
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
   * Reads the B/L's title as a user: the raw answer.
   * @param user the caller
   * @return the answer
   */
  function read(user: SignedIn) {
    return api.get(`/api/records/${recordId}/title`, {headers: user.headers});
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
    buyer = await organisationWithClerk(api, admin, 'Buyer');
    outsider = await organisationWithClerk(api, admin, 'Outsider');
    const organisations = [
      carrier.organisationId,
      shipper.id,
      bank.id,
      buyer.id,
      outsider.id,
    ];
    expect(new Set(organisations).size).toBe(5);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test("the carrier's B/L to order, its shipper linked, is committed with four eyes and not issued yet", async () => {
    const created = await api.post('/api/records', {
      headers: carrier.headers,
      data: {
        format: 'dcsa-3.0',
        document: negotiableBl(`CB34${unique().toUpperCase()}`.slice(0, 20)),
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

    const res = await read(carrier);
    expect(res.status(), await res.text()).toBe(200);
    const view: TitleView = await res.json();
    expect([view.title, view.allowedCommands, view.chain]).toEqual([
      null,
      ['issue'],
      [],
    ]);
  });

  test('the carrier issues it to the shipper; the shipper endorses it to the bank; the bank to the buyer', async () => {
    const issued = await run('issue', carrier);
    expect(issued.title).toMatchObject({
      kind: 'negotiable',
      state: 'issued',
      carrier: carrier.organisationId,
      holder: shipper.id,
    });

    const toBank = await run('endorse', shipper.clerk, {
      to: bank.id,
      inBlank: false,
    });
    expect(toBank.title).toMatchObject({
      state: 'with-holder',
      holder: bank.id,
      endorsement: 'named',
    });

    const toBuyer = await run('endorse', bank.clerk, {
      to: buyer.id,
      inBlank: false,
    });
    expect(toBuyer.title).toMatchObject({
      state: 'with-holder',
      holder: buyer.id,
    });
  });

  test("a past holder's endorsement is refused with the reason; an outsider does not see the B/L; nothing is recorded", async () => {
    const byShipper = await command('endorse', shipper.clerk, {
      to: outsider.id,
      inBlank: false,
    });
    expect(byShipper.status(), await byShipper.text()).toBe(403);
    expect((await byShipper.json()).message).toBe(
      'Only the current holder may endorse this B/L',
    );

    // the shipper, a past holder, still reads it, and may run nothing
    const past = await read(shipper.clerk);
    expect(past.status(), await past.text()).toBe(200);
    expect((await past.json()).allowedCommands).toEqual([]);

    for (const res of [
      await read(outsider.clerk),
      await command('surrender', outsider.clerk),
    ]) {
      expect(res.status(), await res.text()).toBe(404);
      expect((await res.json()).message).toBe('B/L not found');
    }

    // possession goes only to a registered organisation
    const nowhere = await command('endorse', buyer.clerk, {
      to: '00000000-0000-4000-8000-000000000000',
      inBlank: false,
    });
    expect(nowhere.status(), await nowhere.text()).toBe(422);

    const unsigned = await api.post(
      `/api/records/${recordId}/title/surrender`,
      {data: {}},
    );
    expect(unsigned.status()).toBe(401);

    const view: TitleView = await (await read(buyer.clerk)).json();
    expect(view.chain).toHaveLength(3);
    expect(view.title?.holder).toBe(buyer.id);
  });

  test('the buyer surrenders it to the carrier, who releases it: the chain of title holds the five steps', async () => {
    const surrendered = await run('surrender', buyer.clerk);
    expect(surrendered.title).toMatchObject({
      state: 'surrendered',
      holder: carrier.organisationId,
    });
    const released = await run('release', carrier);
    expect(released.title).toMatchObject({state: 'accomplished', holder: null});

    expect(released.chain.map(e => e.command)).toEqual([
      'issue',
      'endorse',
      'endorse',
      'surrender',
      'release',
    ]);
    expect(released.chain.map(e => [e.from, e.to])).toEqual([
      [null, shipper.id],
      [shipper.id, bank.id],
      [bank.id, buyer.id],
      [buyer.id, carrier.organisationId],
      [carrier.organisationId, null],
    ]);
    expect(released.chain.map(e => e.actor.org)).toEqual([
      carrier.organisationId,
      shipper.id,
      bank.id,
      buyer.id,
      carrier.organisationId,
    ]);
  });

  test('the audit trail holds the five title events, each with the acting organisation, and none for the refusals', async () => {
    const titleEvents = async () => {
      const res = await api.get(`/api/audit/trail?subject=record:${recordId}`, {
        headers: admin.headers,
      });
      expect(res.status(), await res.text()).toBe(200);
      const {entries} = await res.json();
      return entries.filter((e: {type: string}) =>
        e.type.startsWith('records.title.'),
      );
    };
    await expect
      .poll(
        async () => (await titleEvents()).map((e: {type: string}) => e.type),
        {
          timeout: 30_000,
        },
      )
      .toEqual([
        'records.title.issue',
        'records.title.endorse',
        'records.title.endorse',
        'records.title.surrender',
        'records.title.release',
      ]);
    const events = await titleEvents();
    expect(events.map((e: {actor: {org: string}}) => e.actor.org)).toEqual([
      carrier.organisationId,
      shipper.id,
      bank.id,
      buyer.id,
      carrier.organisationId,
    ]);
  });
});

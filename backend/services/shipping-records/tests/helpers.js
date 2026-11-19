import {readFileSync, readdirSync} from 'node:fs';

import {
  AppError,
  createEventBus,
  createSequelize,
  ensureSchema,
  inTransaction,
} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {modulesFromSettings} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';

import {buildApp} from '../src/app.js';
import {ShippingRecordsService} from '../src/records.service.js';
import {TitleService} from '../src/title.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {SCHEMA} from '../src/repo/models.js';
import {createSequelizeRepo} from '../src/repo/sequelize.js';

export const SECRET = 'shipping-test-secret-shipping-test-secret';

/** The setting with a PostgreSQL database for the tests; without it they run in memory only. */
const TEST_DB = process.env.SHIPPING_RECORDS_TEST_DB;

const EXAMPLES = new URL(
  '../../../domains/shipping/dcsa/3.0.3/examples/',
  import.meta.url,
);
/** The DCSA eBL 3.0.3 example documents. */
export const EXAMPLE_FILES = readdirSync(EXAMPLES).filter(f =>
  f.endsWith('.json'),
);

/**
 * A DCSA example transport document as a carrier sends it (with its DCSA status).
 * @param {string} [file]
 * @return {object}
 */
export function example(file = 'td-regular.json') {
  return JSON.parse(readFileSync(new URL(file, EXAMPLES), 'utf8'));
}

/**
 * A DCSA example with its own transport document reference, so each B/L of a test is new.
 * @param {string} reference
 * @param {string} [file]
 * @return {object}
 */
export function exampleWithReference(reference, file) {
  return {...example(file), transportDocumentReference: reference};
}

const DRAFTER = ['bl.read', 'bl.draft'];
/** Users of two organisations, a reader, and a user of no organisation. */
export const users = {
  a1: {id: 'u-a1', name: 'Anna Shikongo', org: 'org-a', perms: DRAFTER},
  a2: {id: 'u-a2', name: 'Petrus Amutenya', org: 'org-a', perms: DRAFTER},
  aReader: {id: 'u-a3', name: 'Rosa Kandjii', org: 'org-a', perms: ['bl.read']},
  b1: {id: 'u-b1', name: 'Hendrik Visser', org: 'org-b', perms: DRAFTER},
  noOrg: {id: 'u-x', name: 'Lukas Haufiku', perms: DRAFTER},
};
/**
 * The person a review decision is made by.
 * @param {{id: string, name: string}} u a user
 * @return {{id: string, name: string}}
 */
export const by = u => ({id: u.id, name: u.name});

/**
 * A test clock that starts at `start` and moves a minute each time it is read, so every change
 * has its own time.
 * @param {number} [start]
 * @return {function(): Date}
 */
export function makeClock(start = Date.parse('2026-11-14T08:00:00Z')) {
  let now = start;
  return () => {
    now += 60_000;
    return new Date(now);
  };
}

/**
 * The stores the tests run on: memory always, PostgreSQL too when SHIPPING_RECORDS_TEST_DB names a
 * database (its schema `shipping_records` is emptied before each test).
 * @return {!Array<{name: string, open: function(): Promise<object>}>}
 */
export function stores() {
  const list = [
    {name: 'memory', open: async () => ({repo: createMemoryRepo()})},
  ];
  if (TEST_DB) {
    list.push({name: 'PostgreSQL', open: openPostgres});
  }
  return list;
}

/**
 * The PostgreSQL repo on an emptied schema, with the transactions the service runs in (as the
 * outbox gives them in production).
 * @return {Promise<object>}
 */
async function openPostgres() {
  const sequelize = createSequelize({url: TEST_DB, poolSize: 2});
  await ensureSchema(sequelize, SCHEMA);
  const repo = createSequelizeRepo(sequelize);
  await repo.sync();
  await sequelize.query(
    `TRUNCATE "${SCHEMA}"."bl_title", "${SCHEMA}"."bl_version", "${SCHEMA}"."bill_of_lading" CASCADE`,
  );
  return {
    repo,
    sequelize,
    atomic: fn => inTransaction(sequelize, fn),
    close: () => sequelize.close(),
  };
}

/**
 * Identity as the title service's client sees it, answering every organisation registered and
 * active: for the tests of the engine's service (CB-31..33), whose organisations are not
 * registered anywhere. The registration check itself is tested in title-api.test.js (CB-34).
 * @type {{standingOf: function(string): !Promise<string>}}
 */
export const ACTIVE_ORGANISATIONS = Object.freeze({
  /**
   * Every organisation is active.
   * @return {!Promise<string>}
   */
  async standingOf() {
    return 'active';
  },
});

/**
 * The service behind its HTTP app on a store: `as(user)` gives that user's auth header,
 * `published` every event. With a `signer`, the title service (CB-31) signing its chain entries
 * with it (CB-32) is on the app too; `audit` is its client of the audit service, which gives the
 * trail-entry proof of an entry's event (CB-33); `organisations` its client of identity, which
 * says whether an organisation is registered and active (CB-34); `modules` the title modules on
 * (all by default, as `modulesFromSettings` reads them; CB-35 turns some off).
 * @param {{open: function(): Promise<object>}} store
 * @param {{
 *   formats?: ReadonlyArray<object>,
 *   signer?: object,
 *   audit?: object,
 *   organisations?: object,
 *   modules?: ReadonlyArray<string>,
 *   ports?: object,
 *   carriers?: object,
 * }} [options] `ports`: the port list (CB-63); `carriers`: the SMDG carrier list (CB-68)
 * @return {Promise<object>}
 */
export async function makeHttp(
  store,
  {
    formats,
    signer,
    audit,
    organisations = ACTIVE_ORGANISATIONS,
    modules = modulesFromSettings({}),
    ports = null,
    carriers = null,
  } = {},
) {
  const {repo, atomic, close, sequelize} = await store.open();
  const bus = createEventBus({driver: 'memory', source: 'shipping-records'});
  const events = atomic ? {...bus, atomic} : bus;
  const published = [];
  bus.subscribe('*', e => published.push(e));
  const service = new ShippingRecordsService({
    repo,
    events,
    formats: formats ?? formatsFromSettings({}),
    clock: makeClock(),
    ports,
    carriers,
  });
  let titles = null;
  if (signer) {
    titles = new TitleService({
      repo,
      events,
      modules,
      clock: makeClock(),
      signer,
      audit,
      organisations,
      ports,
      carriers,
    });
  }
  const app = await buildApp({service, titles, jwtSecret: SECRET});
  await app.ready();
  /**
   * A user's auth header.
   * @param {object} u
   * @return {{authorization: string}}
   */
  const as = u => ({
    authorization: `Bearer ${app.jwt.sign({typ: 'access', sub: u.id, name: u.name, org: u.org, perms: u.perms})}`,
  });
  return {
    app,
    service,
    titles,
    repo,
    sequelize,
    published,
    as,
    close: async () => {
      await app.close();
      await close?.();
    },
  };
}

/**
 * Creates a B/L as a user over HTTP: the raw answer.
 * @param {object} ctx makeHttp's answer
 * @param {object} user
 * @param {object} document a DCSA transport document
 * @param {object} [extra] more body fields (partyOrganisations, another format)
 * @return {Promise<object>}
 */
export function createAs(ctx, user, document, extra = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/records',
    headers: ctx.as(user),
    payload: {format: 'dcsa-3.0', document, ...extra},
  });
}

/**
 * A B/L of `user`'s organisation, its first draft submitted by them: the record's id.
 * @param {object} ctx
 * @param {object} user
 * @param {string} reference
 * @return {Promise<string>}
 */
export async function submittedDraft(ctx, user, reference) {
  const created = await createAs(ctx, user, exampleWithReference(reference));
  if (created.statusCode !== 201) {
    throw new Error(`Creating the B/L failed: ${created.body}`);
  }
  const id = created.json().id;
  const submitted = await ctx.app.inject({
    method: 'POST',
    url: `/records/${id}/versions/1/submit`,
    headers: ctx.as(user),
  });
  if (submitted.statusCode !== 200) {
    throw new Error(`Submitting the B/L failed: ${submitted.body}`);
  }
  return id;
}

const ALL_TITLE_PERMS = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];

/**
 * A person of an organisation with B/L permissions (`ALL_TITLE_PERMS` by default).
 * @param {string} org
 * @param {!Array<string>} [perms]
 * @return {{id: string, name: string, org: string, perms: !Array<string>}}
 */
export function staffOf(org, perms = ALL_TITLE_PERMS) {
  return {id: `u-${org}`, name: `Staff of ${org}`, org, perms};
}

/**
 * The audit stand-in with nothing anchored yet (404 on every entry proof).
 */
export const NOTHING_ANCHORED = Object.freeze({
  /** @return {!Promise<object>} */
  async entryProof() {
    throw new AppError(404, 'There is no trail entry for this event');
  },
});

/**
 * Identity stand-in with a fixed set of active organisations (plus optional suspended/operator).
 * @param {!Array<string>} active
 * @param {{suspended?: !Array<string>, operator?: ?string}} [extra]
 * @return {object}
 */
export function standInIdentity(
  active = [
    'org-carrier',
    'org-shipper',
    'org-bank',
    'org-buyer',
    'org-stranger',
  ],
  {suspended = [], operator = null} = {},
) {
  const standings = new Map([
    ...active.map(id => [id, 'active']),
    ...suspended.map(id => [id, 'inactive']),
    ...(operator ? [[operator, 'operator']] : []),
  ]);
  const identity = {
    asked: [],
    down: false,
    meanwhile: null,
    async standingOf(id) {
      identity.asked.push(id);
      if (identity.meanwhile !== null) {
        const run = identity.meanwhile;
        identity.meanwhile = null;
        await run();
      }
      if (identity.down) {
        throw new AppError(503, 'The identity service cannot be reached');
      }
      return standings.get(id) ?? 'unknown';
    },
  };
  return identity;
}

/**
 * Runs a title command over HTTP: the raw Fastify inject response.
 * @param {object} ctx
 * @param {string} id
 * @param {string} name
 * @param {?object} user
 * @param {object} [body]
 * @return {!Promise<object>}
 */
export function titleCommand(ctx, id, name, user, body = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/records/${id}/title/${name}`,
    headers: user ? ctx.as(user) : {},
    payload: body,
  });
}

/**
 * Runs a title command over HTTP expecting 200 and returning its parsed JSON body.
 * @param {object} ctx
 * @param {string} id
 * @param {string} name
 * @param {object} user
 * @param {object} [body]
 * @return {!Promise<object>}
 */
export async function titleOk(ctx, id, name, user, body = {}) {
  const res = await titleCommand(ctx, id, name, user, body);
  expect(res.statusCode, `${name}: ${res.body}`).to.equal(200);
  return res.json();
}

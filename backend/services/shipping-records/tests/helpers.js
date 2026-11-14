import {readFileSync, readdirSync} from 'node:fs';

import {
  createEventBus,
  createSequelize,
  ensureSchema,
  inTransaction,
} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';

import {buildApp} from '../src/app.js';
import {ShippingRecordsService} from '../src/records.service.js';
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
    `TRUNCATE "${SCHEMA}"."bl_title", "${SCHEMA}"."bl_version", "${SCHEMA}"."bill_of_lading"`,
  );
  return {
    repo,
    sequelize,
    atomic: fn => inTransaction(sequelize, fn),
    close: () => sequelize.close(),
  };
}

/**
 * The service behind its HTTP app on a store: `as(user)` gives that user's auth header,
 * `published` every event.
 * @param {{open: function(): Promise<object>}} store
 * @param {{formats?: ReadonlyArray<object>}} [options]
 * @return {Promise<object>}
 */
export async function makeHttp(store, {formats} = {}) {
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
  });
  const app = await buildApp({service, jwtSecret: SECRET});
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

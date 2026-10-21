import {createEventBus, createServiceTokenSigner} from '@lrfe/common';
import {ExtractsService} from '../src/extracts.service.js';
import {createRecordsClient} from '../src/records-client.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {buildApp} from '../src/app.js';
import {
  SECRET,
  actor,
  commitVersion,
  erf1873,
  erf1873Data,
  makeHttp as makeRecords,
  users as recordsUsers,
} from '../../land-records/tests/helpers.js';

export {SECRET, actor};

export const users = {
  // the records officer at the counter: issues and revokes extracts
  rec: {
    ...recordsUsers.rec,
    perms: [...recordsUsers.rec.perms, 'extract.issue'],
  },
  // the registrar: views records, but does not issue extracts
  sup: recordsUsers.sup,
};

/** A test clock that starts at `start` and moves only when advanced. */
export function makeClock(start = Date.parse('2026-10-21T08:00:00Z')) {
  let now = start;
  const clock = () => new Date(now);
  clock.advance = ms => {
    now += ms;
  };
  return clock;
}

/**
 * The audit service's anchoring status as the extracts service reads it: every version confirmed
 * on the blockchain, unless `status[key]` says otherwise (null: not in the tree yet); with `down`,
 * nothing is known (the client's answer when the audit service cannot be reached).
 */
export function fakeAnchoring() {
  const status = {};
  return {
    status,
    down: false,
    async statusOf(keys) {
      if (this.down) return {};
      return Object.fromEntries(
        keys.map(key => [
          key,
          key in status ? status[key] : {status: 'confirmed'},
        ]),
      );
    },
  };
}

/**
 * The extracts service behind its HTTP app, reading a real in-process land-records app (its routes,
 * its guard on the extracts service token) over app.inject, and the audit service's anchoring
 * status from fakeAnchoring. `records` is that land-records context: `service`, `repo`, `clock`,
 * for making records and committing versions.
 */
export async function makeExtracts() {
  const records = await makeRecords();
  const fetchImpl = async (url, {method, headers}) => {
    const u = new URL(url);
    const r = await records.app.inject({
      method,
      url: u.pathname + u.search,
      headers,
    });
    return {status: r.statusCode, text: async () => r.body};
  };
  const repo = createMemoryRepo();
  const events = createEventBus({driver: 'memory', source: 'extracts'});
  const published = [];
  events.subscribe('*', e => published.push(e));
  const clock = makeClock();
  const anchoring = fakeAnchoring();
  const service = new ExtractsService({
    repo,
    events,
    clock,
    anchoring,
    records: createRecordsClient({
      baseUrl: 'http://records',
      serviceToken: createServiceTokenSigner({
        secret: SECRET,
        service: 'extracts',
      }),
      fetchImpl,
    }),
  });
  const app = await buildApp({service, jwtSecret: SECRET});
  await app.ready();
  const as = u => ({
    authorization: `Bearer ${app.jwt.sign({typ: 'access', sub: u.id, name: u.name, perms: u.perms})}`,
  });
  return {records, repo, service, published, clock, anchoring, app, as};
}

/** Erf 1873 with version 1 committed: three owners (README.md of land-records, section 2). */
export async function committedErf1873(records) {
  const r = await records.service.createRecord(
    {parcel: erf1873()},
    actor(recordsUsers.rec),
  );
  await commitVersion(records, r.id, 1, erf1873Data());
  return records.service.getRecord(r.id);
}

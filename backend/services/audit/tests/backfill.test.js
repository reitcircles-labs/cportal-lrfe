import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createServiceTokenSigner} from '@lrfe/common';
import {BackfillService, createSealSources} from '../src/backfill.service.js';
import {TrailService} from '../src/trail.service.js';
import {TreeService} from '../src/tree.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {LEAF_TYPES} from '../src/mmr.js';
import {
  actor,
  makeWithReview,
  users,
  SECRET,
} from '../../land-records/tests/helpers.js';

const quiet = {info() {}, warn() {}, error() {}};
const rec = actor(users.rec);

/** The two services' seal lists as the backfill reads them (`{ items, next }` pages). */
const pages = list => async (after, limit) => {
  const items = await list({after, limit});
  const last = items.at(-1);
  return {
    items,
    next:
      items.length === limit
        ? {
            at: last.at,
            id: last.recordId ?? last.documentId,
            version: last.version,
          }
        : null,
  };
};

/**
 * A register that existed before the audit service: the testers' six sample documents filed in
 * edrms, and the land record for Erf 1873 put together from five of them and committed (v1).
 */
async function existingRegister() {
  const ctx = await makeWithReview();
  let r = await ctx.service.createRecord(
    {edrmsDocumentId: ctx.docs.grant.id},
    rec,
  );
  for (const k of ['t1996', 'sg', 't2008', 't2019']) {
    r = await ctx.service.addDocument(
      r.id,
      {revision: r.draft.revision, edrmsDocumentId: ctx.docs[k].id},
      rec,
    );
  }
  r = await ctx.service.updateDraft(
    r.id,
    {
      revision: r.draft.revision,
      accept: ['owners', 'extent'],
      changes: {tenure: 'freehold', attributes: {zoning: 'Residential'}},
    },
    rec,
  );
  await ctx.service.submit(r.id, {revision: r.draft.revision}, rec);
  const [task] = await ctx.inbox(users.sup);
  assert.equal(
    (await ctx.decide(users.sup, task.id, {outcome: 'approved'})).statusCode,
    200,
  );
  return {...ctx, record: await ctx.service.getRecord(r.id)};
}

function makeAudit(sources, opts = {}) {
  const repo = createMemoryRepo();
  const trail = new TrailService({repo, logger: quiet});
  const tree = new TreeService({repo, logger: quiet});
  return {
    repo,
    trail,
    tree,
    backfill: new BackfillService({
      trail,
      tree,
      sources,
      logger: quiet,
      ...opts,
    }),
  };
}

describe('backfill of seals from before the audit service (API-669)', () => {
  it('every document version and committed land record version becomes a leaf, oldest first, recorded once in the trail', async () => {
    const reg = await existingRegister();
    const a = makeAudit({
      records: pages(p => reg.service.listSeals(p)),
      documents: pages(p => reg.edrmsService.listSeals(p)),
    });
    const r = await a.backfill.run();
    assert.deepEqual(
      [r.records, r.documents, r.added, r.alreadyInTree],
      [1, 6, 7, 0],
    );
    // oldest first, by each seal's own time
    const at = new Map([
      ...(await reg.edrmsService.listSeals({limit: 100})).map(x => [
        `document-version:${x.documentId}:${x.version}`,
        new Date(x.at),
      ]),
      ...(await reg.service.listSeals({limit: 100})).map(x => [
        `record-version:${x.recordId}:${x.version}`,
        new Date(x.at),
      ]),
    ]);
    const times = a.repo.leaves.map(l => at.get(l.key));
    assert.ok(
      times.every((t, i) => i === 0 || times[i - 1] <= t),
      'leaves are in time order',
    );
    assert.deepEqual(
      new Set(a.repo.leaves.map(l => l.key)),
      new Set([
        ...Object.values(reg.docs).map(d => `document-version:${d.id}:1`),
        `record-version:${reg.record.id}:1`,
      ]),
    );
    const recordLeaf = a.repo.leaves.find(
      l => l.key === `record-version:${reg.record.id}:1`,
    );
    assert.equal(recordLeaf.type, LEAF_TYPES.recordVersion);
    assert.equal(recordLeaf.item, reg.record.current.seal);
    const doc = await reg.edrmsService.getDocument(reg.docs.t2019.id);
    assert.equal(
      a.repo.leaves.find(l => l.key === `document-version:${doc.id}:1`).item,
      doc.versions[0].seal,
    );
    // one trail entry with the counts
    const entries = (await a.trail.list({type: 'audit.backfill.completed'}))
      .entries;
    assert.equal(entries.length, 1);
    assert.deepEqual(
      [
        entries[0].data.records,
        entries[0].data.documents,
        entries[0].data.added,
        entries[0].data.fromLeaf,
        entries[0].data.toLeaf,
      ],
      [1, 6, 7, 0, 6],
    );
    // proofs work for backfilled leaves
    const p = await a.tree.inclusionProof(`record-version:${reg.record.id}:1`);
    assert.equal(p.leaf.item, reg.record.current.seal);
  });

  it('running it again adds nothing and records nothing; seals already in the tree through live events are skipped', async () => {
    const reg = await existingRegister();
    const sources = {
      records: pages(p => reg.service.listSeals(p)),
      documents: pages(p => reg.edrmsService.listSeals(p)),
    };
    const a = makeAudit(sources);
    // the audit service already received the commit event (it started before the commit)
    await a.tree.fromEvent({
      id: randomUUID(),
      type: 'records.record.committed',
      source: 'land-records',
      time: new Date().toISOString(),
      data: {
        recordId: reg.record.id,
        versionNumber: 1,
        seal: reg.record.current.seal,
      },
    });
    const first = await a.backfill.run();
    assert.deepEqual([first.added, first.alreadyInTree], [6, 1]);
    const again = await a.backfill.run();
    assert.deepEqual([again.added, again.alreadyInTree], [0, 7]);
    assert.equal(
      (await a.trail.list({type: 'audit.backfill.completed'})).total,
      1,
    );
    assert.equal(await a.tree.size(), 7);
  });

  it('small pages and small batches give the same tree; the two lists are merged by time', async () => {
    const reg = await existingRegister();
    const sources = {
      records: pages(p => reg.service.listSeals(p)),
      documents: pages(p => reg.edrmsService.listSeals(p)),
    };
    const big = makeAudit(sources);
    const small = makeAudit(sources, {pageSize: 2, batchSize: 3});
    await big.backfill.run();
    await small.backfill.run();
    assert.deepEqual(await small.tree.root(), await big.tree.root());

    const at = m => new Date(Date.UTC(2026, 9, 1, 8, m)).toISOString();
    const s = n => n.toString(16).padStart(64, '0');
    const merged = makeAudit({
      records: async () => ({
        items: [
          {recordId: 'r1', version: 1, seal: s(1), at: at(2)},
          {recordId: 'r1', version: 2, seal: s(2), at: at(5)},
        ],
        next: null,
      }),
      documents: async () => ({
        items: [
          {documentId: 'd1', version: 1, seal: s(3), at: at(1)},
          {documentId: 'd2', version: 1, seal: s(4), at: at(3)},
          {documentId: 'd1', version: 2, seal: s(5), at: at(6)},
        ],
        next: null,
      }),
    });
    await merged.backfill.run();
    assert.deepEqual(
      merged.repo.leaves.map(l => l.key),
      [
        'document-version:d1:1',
        'record-version:r1:1',
        'document-version:d2:1',
        'record-version:r1:2',
        'document-version:d1:2',
      ],
    );
  });

  it('an empty register: nothing added, nothing recorded', async () => {
    const a = makeAudit({
      records: async () => ({items: [], next: null}),
      documents: async () => ({items: [], next: null}),
    });
    assert.deepEqual(
      (({records, documents, added}) => ({records, documents, added}))(
        await a.backfill.run(),
      ),
      {records: 0, documents: 0, added: 0},
    );
    assert.equal((await a.trail.list()).total, 0);
  });

  it('a service that cannot be reached fails the run; running it later completes it', async () => {
    const reg = await existingRegister();
    let down = true;
    const a = makeAudit({
      records: async (after, l) => {
        if (down) throw new Error('land-records cannot be reached');
        return pages(p => reg.service.listSeals(p))(after, l);
      },
      documents: pages(p => reg.edrmsService.listSeals(p)),
    });
    await assert.rejects(a.backfill.run(), /cannot be reached/);
    down = false;
    assert.equal((await a.backfill.run()).added, 7);
  });

  it('a run that fails half-way is finished by the retry (until done): every seal once', async () => {
    const reg = await existingRegister();
    let failures = 1;
    let calls = 0;
    const docs = pages(p => reg.edrmsService.listSeals(p));
    const a = makeAudit(
      {
        records: pages(p => reg.service.listSeals(p)),
        documents: async (after, l) => {
          if (++calls === 3 && failures-- > 0) {
            throw new Error('page timed out');
          }
          return docs(after, l);
        },
      },
      {pageSize: 2, batchSize: 2},
    );
    const retried = [];
    const r = await a.backfill.untilDone({
      retryMs: 1,
      onRetry: err => retried.push(err.message),
      sleep: async () => {},
    });
    assert.deepEqual(retried, ['page timed out']);
    assert.ok(
      r.alreadyInTree > 0,
      'the first run had added some before failing',
    );
    assert.equal(await a.tree.size(), 7);
    assert.equal(new Set(a.repo.leaves.map(l => l.key)).size, 7);
  });

  it('over HTTP: the lists are for the audit service only', async () => {
    const reg = await existingRegister();
    const {buildApp: buildEdrms} = await import('../../edrms/src/app.js');
    const edrmsApp = await buildEdrms({
      service: reg.edrmsService,
      jwtSecret: SECRET,
    });
    await edrmsApp.ready();
    const inject =
      app =>
      async (url, {headers}) => {
        const u = new URL(url);
        const r = await app.inject({url: u.pathname + u.search, headers});
        return {status: r.statusCode, text: async () => r.body};
      };
    const asService = service =>
      createServiceTokenSigner({secret: SECRET, service});
    const routed = (url, init) =>
      (url.includes('/records/') ? inject(reg.app) : inject(edrmsApp))(
        url,
        init,
      );
    const audit = makeAudit(
      createSealSources({
        recordsUrl: 'http://records',
        edrmsUrl: 'http://edrms',
        serviceToken: asService('audit'),
        fetchImpl: routed,
      }),
      {pageSize: 4},
    );
    assert.equal((await audit.backfill.run()).added, 7);
    // another service or a user may not read them
    const intruder = createSealSources({
      recordsUrl: 'http://records',
      edrmsUrl: 'http://edrms',
      serviceToken: asService('bpm'),
      fetchImpl: routed,
    });
    await assert.rejects(intruder.records(0, 10), /\(403\)/);
    await assert.rejects(intruder.documents(0, 10), /\(403\)/);
    const user = reg.app.jwt.sign({
      typ: 'access',
      sub: 'u3',
      name: 'Auditor',
      perms: ['audit.view', 'record.view'],
    });
    assert.ok(
      [401, 403].includes(
        (
          await reg.app.inject({
            url: '/records/seals',
            headers: {authorization: `Bearer ${user}`},
          })
        ).statusCode,
      ),
    );
    assert.equal(
      (
        await edrmsApp.inject({
          url: '/documents/seals?limit=5000',
          headers: {authorization: `Bearer ${asService('audit')()}`},
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await reg.app.inject({
          url: '/records/seals?after=bm90LWEtY3Vyc29y',
          headers: {authorization: `Bearer ${asService('audit')()}`},
        })
      ).statusCode,
      400,
    );
    for (const bad of [
      {at: 'x', id: reg.record.id, version: 1},
      {at: new Date().toISOString(), id: "1' OR '1'='1", version: 1},
      {at: new Date().toISOString(), id: reg.record.id, version: '1'},
    ]) {
      const after = Buffer.from(JSON.stringify(bad)).toString('base64url');
      assert.equal(
        (
          await reg.app.inject({
            url: `/records/seals?after=${after}`,
            headers: {authorization: `Bearer ${asService('audit')()}`},
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await edrmsApp.inject({
            url: `/documents/seals?after=${after}`,
            headers: {authorization: `Bearer ${asService('audit')()}`},
          })
        ).statusCode,
        400,
      );
    }
    // a cursor walks the whole list, page by page
    const walk = async (app, path) => {
      const seen = [];
      let after = null;
      do {
        const page = (
          await app.inject({
            url: `${path}?limit=2${after ? `&after=${after}` : ''}`,
            headers: {authorization: `Bearer ${asService('audit')()}`},
          })
        ).json();
        seen.push(...page.items);
        after = page.next;
      } while (after);
      return seen;
    };
    assert.equal((await walk(edrmsApp, '/documents/seals')).length, 6);
    assert.equal((await walk(reg.app, '/records/seals')).length, 1);
  });
});

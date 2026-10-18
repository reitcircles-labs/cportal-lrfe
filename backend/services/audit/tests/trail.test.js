import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createEventBus} from '@lrfe/common';
import {TrailService} from '../src/trail.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {buildApp} from '../src/app.js';
import {contentHash, chainHash, ZERO_HASH} from '../src/chain.js';
import {subjectsOf} from '../src/subjects.js';
import {
  actor,
  makeWithReview,
  users,
} from '../../land-records/tests/helpers.js';

const SECRET = 'audit-test-secret-audit-test-secret';
const quiet = {error() {}, info() {}, warn() {}};
const event = (type, data = {}, extra = {}) => ({
  id: randomUUID(),
  type,
  source: type.split('.')[0].replace('records', 'land-records'),
  time: new Date().toISOString(),
  actor: {id: 'u7', name: 'Josef Gawaseb'},
  data,
  ...extra,
});

function makeTrail() {
  const repo = createMemoryRepo();
  return {repo, trail: new TrailService({repo, logger: quiet})};
}

describe('audit trail: one entry per event (API-654)', () => {
  it('an event becomes exactly one entry, also when it is delivered again or twice at once', async () => {
    const {repo, trail} = makeTrail();
    const e = event('edrms.document.filed', {
      documentId: 'd1',
      edrmsNo: 'EDR-NA-2026-000001',
    });
    const first = await trail.record(e);
    assert.equal(first.seq, 1);
    assert.equal(await trail.record(e), null); // redelivered after a crash
    const both = await Promise.all([
      trail.record(event('a.b.c')),
      trail.record(e),
    ]);
    assert.equal(both[1], null);
    assert.equal(repo.entries.length, 2);
    assert.deepEqual(
      repo.entries.map(x => x.seq),
      [1, 2],
    );
  });

  it('a message that is not a domain event is skipped, not retried forever', async () => {
    const {repo, trail} = makeTrail();
    assert.equal(await trail.record({type: 'x.y.z'}), null);
    assert.equal(await trail.record({id: 'e1'}), null);
    assert.equal(repo.entries.length, 0);
  });

  it('an entry keeps who, what, when, the subjects and the event itself', async () => {
    const {trail} = makeTrail();
    const e = event(
      'records.record.committed',
      {
        recordId: 'r1',
        recordNo: 'LR-NA-2026-000001',
        versionNumber: 1,
        seal: 'f'.repeat(64),
        submittedBy: {id: 'u7'},
        approvedBy: {id: 'u1', name: 'Elina Shivute'},
      },
      {actor: {id: 'u1', name: 'Elina Shivute'}},
    );
    await trail.record(e);
    const [entry] = (await trail.list()).entries;
    assert.equal(entry.eventId, e.id);
    assert.equal(entry.type, 'records.record.committed');
    assert.equal(entry.source, 'land-records');
    assert.equal(entry.time, e.time);
    assert.deepEqual(entry.actor, e.actor);
    assert.deepEqual(entry.data, e.data);
    assert.deepEqual(entry.subjects.sort(), [
      'record:r1',
      'user:u1',
      'user:u7',
    ]);
  });

  it('with the in-process bus, consume(">") records every event except broadcast-only ones', async () => {
    const {repo, trail} = makeTrail();
    const bus = createEventBus({driver: 'memory', source: 'identity'});
    bus.consume('>', ev => trail.record(ev), {durable: 'audit-trail'});
    await bus.publish('identity.user.invited', {userId: 'u9'});
    await bus.publish(
      'identity.session.revoked',
      {userId: 'u9'},
      {durable: false},
    );
    assert.deepEqual(
      repo.entries.map(x => x.type),
      ['identity.user.invited'],
    );
  });
});

describe('audit trail: the hash chain (API-654)', () => {
  async function threeEntries() {
    const ctx = makeTrail();
    for (const n of [1, 2, 3]) {
      await ctx.trail.record(
        event('edrms.document.filed', {documentId: `d${n}`}),
      );
    }
    return ctx;
  }

  it('each entry hashes its content and the entry before it; verify recomputes the chain', async () => {
    const {repo, trail} = await threeEntries();
    const [a, b] = repo.entries;
    assert.equal(a.prevHash, ZERO_HASH);
    assert.equal(a.hash, chainHash(ZERO_HASH, contentHash(a)));
    assert.equal(b.prevHash, a.hash);
    const v = await trail.verify();
    assert.deepEqual(v, {
      intact: true,
      entries: 3,
      head: {seq: 3, hash: repo.entries[2].hash, time: repo.entries[2].time},
    });
  });

  it('changing an entry breaks the chain at that entry', async () => {
    const {repo, trail} = await threeEntries();
    repo.entries[1].data.documentId = 'forged';
    assert.deepEqual(await trail.verify(), {
      intact: false,
      entries: 1,
      brokenAt: 2,
      problem: 'changed',
    });
  });

  it('changing an entry and its hashes still breaks the chain at the next one', async () => {
    const {repo, trail} = await threeEntries();
    const e = repo.entries[1];
    e.actor = {id: 'u1', name: 'Someone else'};
    e.contentHash = contentHash(e);
    e.hash = chainHash(e.prevHash, e.contentHash);
    assert.deepEqual(await trail.verify(), {
      intact: false,
      entries: 2,
      brokenAt: 3,
      problem: 'does not follow the entry before it',
    });
  });

  it('deleting an entry breaks the chain there; so does deleting the first', async () => {
    const ctx = await threeEntries();
    ctx.repo.entries.splice(1, 1);
    assert.deepEqual(await ctx.trail.verify(), {
      intact: false,
      entries: 1,
      brokenAt: 2,
      problem: 'missing',
    });
    const other = await threeEntries();
    other.repo.entries.shift();
    assert.deepEqual(await other.trail.verify(), {
      intact: false,
      entries: 0,
      brokenAt: 1,
      problem: 'missing',
    });
  });

  it('an empty trail is intact', async () => {
    assert.deepEqual(await makeTrail().trail.verify(), {
      intact: true,
      entries: 0,
      head: null,
    });
  });
});

describe('audit trail: gaps (API-657)', () => {
  it('events the stream dropped before they were read are recorded once as a gap, loudly', async () => {
    const errors = [];
    const repo = createMemoryRepo();
    const trail = new TrailService({
      repo,
      logger: {error: (o, m) => errors.push([o, m])},
    });
    const published = [];
    let gap = null;
    const events = {
      consumerGap: async () => gap,
      publish: async (type, data, o) => {
        published.push({type, data, o});
      },
    };
    assert.equal(await trail.checkGap(events), null);
    await trail.record(event('edrms.document.filed', {documentId: 'd1'}));
    gap = {from: 120, to: 164};
    const r = await trail.checkGap(events);
    assert.deepEqual(r, {
      consumer: 'audit-trail',
      fromStreamSeq: 120,
      toStreamSeq: 164,
      missing: 45,
      recorded: true,
    });
    assert.equal((await trail.checkGap(events)).recorded, false); // the next hour: not again
    const gaps = (await trail.list({type: 'audit.trail.gap'})).entries;
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].seq, 2);
    assert.equal(gaps[0].source, 'audit');
    assert.equal(errors.length, 1);
    assert.deepEqual(
      published.map(p => [p.type, p.o.durable]),
      [['audit.trail.gap', false]],
    );
    assert.equal((await trail.verify()).intact, true);
  });
});

describe('audit trail: subjects (API-654)', () => {
  it("reads what each service's events are about", () => {
    const s = (type, data, extra) =>
      subjectsOf(event(type, data, extra)).sort();
    assert.deepEqual(
      s('intake.document.captured', {documentId: 'i1', batchId: 'b1'}),
      ['intake:i1', 'user:u7'],
    );
    assert.deepEqual(
      s('edrms.document.filed', {
        documentId: 'd1',
        edrmsNo: 'EDR-1',
        sourceId: 'i1',
      }),
      ['document:d1', 'edrmsNo:EDR-1', 'intake:i1', 'user:u7'],
    );
    assert.deepEqual(
      s('intake.document.filed', {
        documentId: 'i1',
        edrmsDocumentId: 'd1',
        edrmsNo: 'EDR-1',
      }),
      ['document:d1', 'edrmsNo:EDR-1', 'intake:i1', 'user:u7'],
    );
    assert.deepEqual(
      s('records.draft.changed', {
        recordId: 'r1',
        change: {action: 'link', edrmsNo: 'EDR-1'},
      }),
      ['edrmsNo:EDR-1', 'record:r1', 'user:u7'],
    );
    assert.deepEqual(
      s(
        'records.record.flagged',
        {recordId: 'r1', flag: {edrmsDocumentId: 'd1', edrmsNo: 'EDR-1'}},
        {actor: {id: null, name: 'System'}},
      ),
      ['document:d1', 'edrmsNo:EDR-1', 'record:r1'],
    );
    assert.deepEqual(
      s('bpm.instance.started', {
        instanceId: 'p1',
        definitionKey: 'land-record-review',
        businessKey: 'r1',
      }),
      ['process:p1', 'record:r1', 'user:u7'],
    );
    assert.deepEqual(
      s(
        'bpm.task.created',
        {
          instanceId: 'p2',
          definitionKey: 'document-amendment',
          businessKey: 'd1',
        },
        {actor: {id: null}},
      ),
      ['document:d1', 'process:p2'],
    );
    assert.deepEqual(
      s(
        'identity.user.invited',
        {userId: 'u9', email: 'x@example.com'},
        {actor: {id: 'u5'}},
      ),
      ['user:u5', 'user:u9'],
    );
  });
});

describe('audit trail: Erf 1873 from capture to commit (API-654)', () => {
  const rec = actor(users.rec);
  const sup = actor(users.sup);

  /**
   * The testers' sample documents captured and verified in intake, filed in edrms, put together
   * into the land record for Erf 1873, submitted and approved by a second person in bpm: every
   * service's events go to the trail, as the durable consumer would hand them over.
   */
  async function erf1873() {
    const {repo, trail} = makeTrail();
    const tap = e => trail.record(e);
    const intake = createEventBus({driver: 'memory', source: 'intake'});
    intake.subscribe('*', tap);
    const sources = ['s1', 's2', 's3', 's4', 's5']; // the intake documents fileSamples files
    for (const id of sources) {
      await intake.publish(
        'intake.document.captured',
        {documentId: id, batchId: 'b1', sha256: 'a'.repeat(64)},
        {actor: actor(users.scan)},
      );
    }
    for (const id of sources) {
      await intake.publish('intake.document.extracted', {
        documentId: id,
        docType: 'deed_of_transfer',
        flags: 0,
        escalated: false,
      });
    }

    const ctx = await makeWithReview({tap}); // edrms files them (edrms.document.filed)
    for (const [i, k] of ['grant', 't1996', 'sg', 't2008', 't2019'].entries()) {
      await intake.publish(
        'intake.document.filed',
        {
          documentId: sources[i],
          edrmsDocumentId: ctx.docs[k].id,
          edrmsNo: ctx.docs[k].edrmsNo,
        },
        {actor: sup},
      );
    }
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
    r = await ctx.service.submit(r.id, {revision: r.draft.revision}, rec);
    const [task] = await ctx.inbox(users.sup);
    assert.equal(
      (await ctx.decide(users.sup, task.id, {outcome: 'approved'})).statusCode,
      200,
    );
    return {...ctx, repo, trail, record: await ctx.service.getRecord(r.id)};
  }

  it("the record's trail lists every step, from capturing its documents to the commit", async () => {
    const ctx = await erf1873();
    assert.equal(ctx.record.status, 'committed');
    const {entries, total} = await ctx.trail.list({
      subject: `record:${ctx.record.id}`,
      limit: 500,
    });
    assert.equal(total, entries.length);
    const count = type => entries.filter(e => e.type === type).length;
    assert.equal(count('intake.document.captured'), 5);
    assert.equal(count('intake.document.extracted'), 5);
    assert.equal(count('edrms.document.filed'), 5);
    assert.equal(count('intake.document.filed'), 5);
    assert.equal(count('records.record.created'), 1);
    assert.ok(count('records.draft.changed') >= 5); // four documents linked, suggestions accepted
    for (const t of [
      'records.draft.submitted',
      'bpm.instance.started',
      'bpm.task.created',
      'bpm.task.completed',
      'records.record.committed',
      'bpm.instance.completed',
    ]) {
      assert.equal(count(t), 1, t);
    }
    // in the order they happened: capture first, the commit and the end of the review last
    assert.equal(entries[0].type, 'intake.document.captured');
    const order = entries.map(e => e.type);
    assert.ok(
      order.indexOf('records.record.committed') >
        order.indexOf('bpm.task.completed'),
    );
    assert.ok(
      order.lastIndexOf('edrms.document.filed') <
        order.indexOf('records.record.created'),
    );
    const committed = entries.find(e => e.type === 'records.record.committed');
    assert.equal(committed.actor.id, users.sup.id);
    assert.equal(committed.data.seal, ctx.record.current.seal);
    // the sixth sample (Erf 3329, Olympia) is not part of it
    assert.ok(!entries.some(e => e.data.edrmsNo === ctx.docs.olympia.edrmsNo));
    assert.equal((await ctx.trail.verify()).intact, true);
  });

  it("a document shared with another record does not bring that record's steps along", async () => {
    const ctx = await erf1873();
    const other = await ctx.service.createRecord(
      {
        parcel: {
          kind: 'erf',
          number: '3329',
          township: 'Olympia',
          regDiv: 'K',
          region: 'Khomas',
        },
      },
      rec,
    );
    await ctx.service.addDocument(
      other.id,
      {revision: other.draft.revision, edrmsDocumentId: ctx.docs.t2019.id},
      rec,
    );
    const mine = (
      await ctx.trail.list({subject: `record:${ctx.record.id}`, limit: 500})
    ).entries;
    assert.ok(!mine.some(e => e.subjects.includes(`record:${other.id}`)));
    // the document's own trail shows both records using it
    const doc = (
      await ctx.trail.list({
        subject: `document:${ctx.docs.t2019.id}`,
        limit: 500,
      })
    ).entries;
    assert.ok(doc.some(e => e.subjects.includes(`record:${ctx.record.id}`)));
    assert.ok(doc.some(e => e.subjects.includes(`record:${other.id}`)));
  });

  it("a user's trail is what they did or what was about them; type and time filter", async () => {
    const ctx = await erf1873();
    const sup1 = (
      await ctx.trail.list({subject: `user:${users.sup.id}`, limit: 500})
    ).entries;
    assert.ok(sup1.length > 0);
    assert.ok(
      sup1.every(
        e =>
          e.actor.id === users.sup.id ||
          e.subjects.includes(`user:${users.sup.id}`),
      ),
    );
    assert.ok(sup1.some(e => e.type === 'records.record.committed'));
    const filed = await ctx.trail.list({type: 'edrms.document.filed'});
    assert.equal(filed.total, 6);
    const allIntake = await ctx.trail.list({type: 'intake.'});
    assert.equal(allIntake.total, 15);
    assert.equal((await ctx.trail.list({from: '2099-01-01'})).total, 0);
    assert.equal((await ctx.trail.list({to: '2000-01-01'})).total, 0);
  });
});

describe('audit trail: HTTP (API-654)', () => {
  async function http() {
    const ctx = makeTrail();
    const app = await buildApp({service: ctx.trail, jwtSecret: SECRET});
    await app.ready();
    const as = perms => ({
      authorization: `Bearer ${app.jwt.sign({typ: 'access', sub: 'u3', name: 'Auditor', perms})}`,
    });
    return {...ctx, app, as};
  }

  it('reading and verifying the trail needs audit.view', async () => {
    const {app, trail, as} = await http();
    await trail.record(event('records.record.created', {recordId: 'r1'}));
    assert.equal((await app.inject({url: '/audit/trail'})).statusCode, 401);
    assert.equal(
      (await app.inject({url: '/audit/trail', headers: as(['record.view'])}))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: '/audit/trail/verify',
          headers: as(['record.view']),
        })
      ).statusCode,
      403,
    );
    const list = await app.inject({
      url: '/audit/trail?subject=record:r1',
      headers: as(['audit.view']),
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().entries[0].type, 'records.record.created');
    const v = await app.inject({
      url: '/audit/trail/verify',
      headers: as(['audit.view']),
    });
    assert.equal(v.json().intact, true);
  });

  it('an unknown subject or a bad date is a 400', async () => {
    const {app, as} = await http();
    assert.equal(
      (
        await app.inject({
          url: '/audit/trail?subject=parcel:1',
          headers: as(['audit.view']),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/audit/trail?from=yesterday',
          headers: as(['audit.view']),
        })
      ).statusCode,
      400,
    );
  });
});

describe('searching the trail by user (API-673)', () => {
  it('lists the people who acted, by name, once each, matching part of the name in any case; the system is not a person', async () => {
    const {trail} = makeTrail();
    await trail.record(event('edrms.document.filed', {documentId: 'd1'}));
    await trail.record(
      event(
        'records.record.created',
        {recordId: 'r1'},
        {actor: {id: 'u2', name: 'Aina Mwandingi'}},
      ),
    );
    await trail.record(
      event(
        'records.draft.changed',
        {recordId: 'r1'},
        {actor: {id: 'u2', name: 'Aina Mwandingi'}},
      ),
    );
    await trail.record(
      event(
        'audit.trail.gap',
        {missing: 3},
        {actor: {id: null, name: 'System'}},
      ),
    );
    assert.deepEqual((await trail.actors()).items, [
      {id: 'u2', name: 'Aina Mwandingi'},
      {id: 'u7', name: 'Josef Gawaseb'},
    ]);
    assert.deepEqual((await trail.actors({q: 'gaWA'})).items, [
      {id: 'u7', name: 'Josef Gawaseb'},
    ]);
    assert.deepEqual((await trail.actors({q: 'nobody'})).items, []);
    assert.deepEqual((await trail.actors({limit: 1})).items.length, 1);
    // that person's actions, through the trail's user subject
    assert.deepEqual(
      (await trail.list({subject: 'user:u2'})).entries.map(e => e.type),
      ['records.record.created', 'records.draft.changed'],
    );
  });

  it('the route needs audit.view', async () => {
    const {trail} = makeTrail();
    const app = await buildApp({service: trail, jwtSecret: SECRET});
    await app.ready();
    const as = perms => ({
      authorization: `Bearer ${app.jwt.sign({typ: 'access', sub: 'u1', name: 'A', perms, roles: []})}`,
    });
    assert.equal(
      (
        await app.inject({
          url: '/audit/trail/actors?q=a',
          headers: as(['audit.view']),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: '/audit/trail/actors',
          headers: as(['record.view']),
        })
      ).statusCode,
      403,
    );
    await app.close();
  });
});

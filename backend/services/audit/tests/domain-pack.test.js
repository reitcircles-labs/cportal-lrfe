import {strict as assert} from 'node:assert';
import {
  createEventBus,
  createServiceTokenSigner,
  loadDomainPack,
  recordServiceOf,
} from '@lrfe/common';

import {buildApp} from '../src/app.js';
import {createListSources} from '../src/audit-list.service.js';
import {createCoverageSources} from '../src/anchorings.service.js';
import {createSealSources} from '../src/backfill.service.js';
import {createEvidenceSources} from '../src/evidence.service.js';
import {createLookupSources} from '../src/lookup.service.js';
import {createVerifySources} from '../src/proof.service.js';
import {createSignoffClients} from '../src/signoff.service.js';
import {AnchorLookupService, classify} from '../src/lookup.service.js';
import {ProofService} from '../src/proof.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {SignoffService} from '../src/signoff.service.js';
import {subjectsOf} from '../src/subjects.js';
import {TrailService} from '../src/trail.service.js';
import {TreeService} from '../src/tree.service.js';

const SECRET = 'a-test-secret-of-at-least-thirty-two-characters';
const quiet = {info() {}, warn() {}, error() {}};
const SEAL = 'ab'.repeat(32);
const RECORD_ID = '00000000-0000-4000-8000-000000000001';

/** A version committed by the land registry's records service. */
const committed = {
  id: 'e1',
  type: 'records.record.committed',
  source: 'land-records',
  actor: {id: 'u1'},
  data: {
    recordId: RECORD_ID,
    versionNumber: 1,
    seal: SEAL,
    change: {edrmsNo: 'EDR-1'},
  },
};

describe('the audit service with a domain pack (CB-3)', () => {
  let land;
  let shipping;
  /** A pack without a record kind: the shipping pack before it had one. */
  let bare;
  before(async () => {
    land = await loadDomainPack('land');
    shipping = await loadDomainPack('shipping');
    bare = {...shipping, recordKind: null};
  });

  it('starts with a pack that has no record kind', async () => {
    const repo = createMemoryRepo();
    const tree = new TreeService({repo, logger: quiet, pack: bare});
    const proofs = new ProofService({
      repo,
      tree,
      logger: quiet,
      pack: bare,
    });
    const signoffs = new SignoffService({
      repo,
      events: createEventBus({driver: 'memory', source: 'audit'}),
      proofs,
      logger: quiet,
      pack: bare,
    });
    const app = await buildApp({
      service: new TrailService({repo, logger: quiet, pack: bare}),
      proofs,
      signoffs,
      lookup: new AnchorLookupService({repo, proofs, pack: bare}),
      jwtSecret: SECRET,
    });
    await app.ready();
    const token = app.jwt.sign({
      typ: 'access',
      sub: 'u3',
      name: 'Auditor',
      perms: ['audit.view'],
      roles: ['aud'],
    });
    const res = await app.inject({
      url: `/audit/proofs/record-version/${RECORD_ID}?version=1`,
      headers: {authorization: `Bearer ${token}`},
    });
    // no record versions to prove in this product
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('records no record subject or tree leaf without a record kind', async () => {
    assert.deepEqual(subjectsOf(committed, land), [
      'user:u1',
      `record:${RECORD_ID}`,
      'edrmsNo:EDR-1',
    ]);
    assert.deepEqual(subjectsOf(committed, bare), ['user:u1']);
    assert.equal(
      TreeService.leafOf(committed, land).key,
      `record-version:${RECORD_ID}:1`,
    );
    assert.equal(TreeService.leafOf(committed, bare), null);

    const repo = createMemoryRepo();
    const trail = new TrailService({repo, logger: quiet, pack: bare});
    const entry = await trail.record(committed);
    assert.deepEqual(entry.subjects, ['user:u1']);
    await assert.rejects(trail.list({subject: `record:${RECORD_ID}`}), {
      message: /use document:, edrmsNo:, intake:, process: or user: and an id/,
    });
  });

  it('offers no record proofs, lookups or commit rule without a record kind', async () => {
    assert.throws(
      () => ProofService.itemOf('record-version', RECORD_ID, 1, bare),
      {
        message:
          'Unknown kind "record-version": use document-version, trail-entry',
      },
    );
    assert.equal(classify('LR-NA-2026-000001', bare), 'none');
    assert.equal(classify('T 2210/2008', bare), 'none');
    assert.equal(classify('EDR-NA-2026-000412', bare), 'edrmsNo');
    const lookup = new AnchorLookupService({pack: bare});
    assert.deepEqual(await lookup.search('Erf 1873', 'u1'), {
      query: 'Erf 1873',
      kind: 'none',
    });

    const committer = {id: 'u9', perms: ['record.finalize']};
    const none = {versions: [], documents: [], openFindings: []};
    assert.equal(
      SignoffService.refusal({...none, actor: committer, pack: land}).rule,
      'sod2',
    );
    assert.equal(
      SignoffService.refusal({...none, actor: committer, pack: bare}),
      null,
    );
  });

  it('names the record service from the pack; without one, record reads answer 503 (CB-4)', async () => {
    assert.equal(recordServiceOf(land).name, 'land-records');
    assert.equal(recordServiceOf(shipping).name, 'shipping-records');
    assert.equal(recordServiceOf(bare), null);

    const fetchImpl = async url => {
      throw new Error(`no call expected, got ${url}`);
    };
    const options = {
      recordsUrl: recordServiceOf(bare)?.url ?? null,
      recordsLabel: null,
      edrmsUrl: 'http://edrms',
      bpmUrl: 'http://bpm',
      serviceToken: () => 't',
      fetchImpl,
    };
    const noService = {
      statusCode: 503,
      message: 'This install has no record service',
    };
    const list = createListSources(options);
    await assert.rejects(
      list.records({status: 'committed', limit: 1, offset: 0}),
      noService,
    );
    await assert.rejects(list.versions(RECORD_ID), noService);
    await assert.rejects(
      createVerifySources(options).recordVersion(RECORD_ID, 1),
      noService,
    );
    const {sources} = createSignoffClients(options);
    await assert.rejects(sources.record(RECORD_ID, 1), noService);
    await assert.rejects(sources.recordInfo(RECORD_ID), noService);
    await assert.rejects(
      createCoverageSources(options).lookup({records: []}),
      noService,
    );
    const lookup = createLookupSources(options);
    await assert.rejects(lookup.records({q: 'x', limit: 1}), noService);
    await assert.rejects(lookup.lookup({records: []}), noService);
    const evidence = createEvidenceSources(options);
    await assert.rejects(evidence.version(RECORD_ID, 1), noService);
    await assert.rejects(
      createSealSources(options).records(null, 10),
      noService,
    );
  });

  it('lets only edrms and extracts read the anchoring status without a record service (CB-4)', async () => {
    const repo = createMemoryRepo();
    const tree = new TreeService({repo, logger: quiet, pack: bare});
    const proofs = new ProofService({
      repo,
      tree,
      logger: quiet,
      pack: bare,
    });
    const app = await buildApp({
      service: new TrailService({repo, logger: quiet, pack: bare}),
      proofs,
      jwtSecret: SECRET,
    });
    await app.ready();
    const ask = service =>
      app.inject({
        method: 'POST',
        url: '/audit/anchoring',
        headers: {
          authorization: `Bearer ${createServiceTokenSigner({secret: SECRET, service})()}`,
        },
        payload: {keys: []},
      });
    assert.equal((await ask('edrms')).statusCode, 200);
    assert.equal((await ask('extracts')).statusCode, 200);
    assert.equal((await ask('land-records')).statusCode, 403);
    await app.close();
  });

  it("records the shipping pack's B/L versions as records: subjects, tree leaves, proofs (CB-28)", () => {
    const bl = {
      ...committed,
      source: 'shipping-records',
      data: {...committed.data, change: undefined},
    };
    assert.deepEqual(subjectsOf(bl, shipping), [
      'user:u1',
      `record:${RECORD_ID}`,
    ]);
    assert.equal(
      TreeService.leafOf(bl, shipping).key,
      `record-version:${RECORD_ID}:1`,
    );
    assert.deepEqual(
      ProofService.itemOf('record-version', RECORD_ID, 1, shipping),
      ProofService.itemOf('record-version', RECORD_ID, 1, land),
    );
    // a B/L number has no pattern of its own: it is looked up as words
    assert.equal(classify('MAEU123456', shipping), 'words');
    assert.equal(classify('EDR-NA-2026-000412', shipping), 'edrmsNo');
    const committer = {id: 'u9', perms: ['bl.draft']};
    const none = {versions: [], documents: [], openFindings: []};
    assert.equal(
      SignoffService.refusal({...none, actor: committer, pack: shipping}),
      null,
    );
  });
});

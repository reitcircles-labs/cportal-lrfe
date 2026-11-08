import {strict as assert} from 'node:assert';
import {createEventBus, loadDomainPack} from '@lrfe/common';

import {buildApp} from '../src/app.js';
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
  before(async () => {
    land = await loadDomainPack('land');
    shipping = await loadDomainPack('shipping');
  });

  it('starts with the shipping pack, which has no record kind', async () => {
    const repo = createMemoryRepo();
    const tree = new TreeService({repo, logger: quiet, pack: shipping});
    const proofs = new ProofService({
      repo,
      tree,
      logger: quiet,
      pack: shipping,
    });
    const signoffs = new SignoffService({
      repo,
      events: createEventBus({driver: 'memory', source: 'audit'}),
      proofs,
      logger: quiet,
      pack: shipping,
    });
    const app = await buildApp({
      service: new TrailService({repo, logger: quiet, pack: shipping}),
      proofs,
      signoffs,
      lookup: new AnchorLookupService({repo, proofs, pack: shipping}),
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
    assert.deepEqual(subjectsOf(committed, shipping), ['user:u1']);
    assert.equal(
      TreeService.leafOf(committed, land).key,
      `record-version:${RECORD_ID}:1`,
    );
    assert.equal(TreeService.leafOf(committed, shipping), null);

    const repo = createMemoryRepo();
    const trail = new TrailService({repo, logger: quiet, pack: shipping});
    const entry = await trail.record(committed);
    assert.deepEqual(entry.subjects, ['user:u1']);
    await assert.rejects(trail.list({subject: `record:${RECORD_ID}`}), {
      message: /use document:, edrmsNo:, intake:, process: or user: and an id/,
    });
  });

  it('offers no record proofs, lookups or commit rule without a record kind', async () => {
    assert.throws(
      () => ProofService.itemOf('record-version', RECORD_ID, 1, shipping),
      {
        message:
          'Unknown kind "record-version": use document-version, trail-entry',
      },
    );
    assert.equal(classify('LR-NA-2026-000001', shipping), 'none');
    assert.equal(classify('T 2210/2008', shipping), 'none');
    assert.equal(classify('EDR-NA-2026-000412', shipping), 'edrmsNo');
    const lookup = new AnchorLookupService({pack: shipping});
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
      SignoffService.refusal({...none, actor: committer, pack: shipping}),
      null,
    );
  });
});

import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {createAnchoringClient, createServiceTokenSigner} from '@lrfe/common';
import {AnchorService} from '../src/anchor.service.js';
import {TrailService} from '../src/trail.service.js';
import {TreeService} from '../src/tree.service.js';
import {ProofService, createVerifySources} from '../src/proof.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {createCardanoAdapter} from '../src/cardano/adapter.js';
import {createLocalSigner} from '../src/cardano/signer.js';
import C from '@emurgo/cardano-serialization-lib-nodejs';
import {AppError} from '@lrfe/common';
import {
  addressOf,
  anchorMetadata,
  buildAnchorTx,
  CardanoError,
  LABEL,
  readAnchorMetadata,
} from '../src/cardano/tx.js';
import {buildApp} from '../src/app.js';
import {checkInclusion, verifyProof} from '../verifier/lrfe-verify.mjs';
import {fakeDriver, PARAMS} from './helpers.js';
import {
  actor,
  makeWithReview,
  users,
  SECRET,
} from '../../land-records/tests/helpers.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const quiet = {info() {}, warn() {}, error() {}};
const rec = actor(users.rec);
const asService = service =>
  createServiceTokenSigner({secret: SECRET, service});
const clone = x => structuredClone(x);

/** Who paid for a transaction: the address of the key that signed it (one input, the signer's). */
const payerOf = cbor =>
  addressOf(
    C.Transaction.from_hex(cbor)
      .witness_set()
      .vkeys()
      .get(0)
      .vkey()
      .public_key()
      .as_bytes(),
    'preview',
  );

/** A public source (Koios or Blockfrost) answering from the fake chain, as the offline verifier reads it. */
function publicSource(driver, {kind = 'koios', metadataOf} = {}) {
  const block = tx => driver.chain.blocks.find(b => b.id === tx);
  const md = b => (metadataOf ? metadataOf(b) : readAnchorMetadata(b.cbor));
  const reply = (body, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  return async (url, init = {}) => {
    const u = new URL(url);
    if (kind === 'koios') {
      assert.equal(u.host, 'preview.koios.rest');
      const [tx] = JSON.parse(init.body)._tx_hashes;
      const b = block(tx);
      if (u.pathname.endsWith('/tx_metadata')) {
        return reply(b ? [{tx_hash: tx, metadata: {[LABEL]: md(b)}}] : []);
      }
      if (u.pathname.endsWith('/tx_status')) {
        return reply([
          {
            tx_hash: tx,
            num_confirmations: b ? driver.chain.height - b.height + 1 : null,
          },
        ]);
      }
      if (u.pathname.endsWith('/tx_info')) {
        assert.equal(JSON.parse(init.body)._inputs, true);
        return reply(
          b
            ? [
                {
                  tx_hash: tx,
                  block_height: b.height,
                  inputs: [{payment_addr: {bech32: payerOf(b.cbor)}}],
                },
              ]
            : [],
        );
      }
    } else {
      assert.equal(u.host, 'cardano-preview.blockfrost.io');
      assert.equal(init.headers.project_id, 'preview-test-key');
      const m = /\/txs\/([0-9a-f]{64})(\/metadata|\/utxos)?$/.exec(u.pathname);
      if (u.pathname.endsWith('/blocks/latest')) {
        return reply({height: driver.chain.height});
      }
      const b = m && block(m[1]);
      if (!b) return reply({status_code: 404}, 404);
      if (m[2] === '/utxos') {
        return reply({
          hash: m[1],
          inputs: [{address: payerOf(b.cbor)}],
          outputs: [],
        });
      }
      if (m[2]) return reply([{label: String(LABEL), json_metadata: md(b)}]);
      return reply({hash: m[1], block_height: b.height});
    }
    throw new Error(`unexpected ${url}`);
  };
}

/**
 * The register of Erf 1873 (the testers' six documents filed in edrms, the land record committed
 * through the review) with the audit service following every event as it happens: trail, tree,
 * hourly anchoring on the fake chain, and proofs with land-records and edrms recomputing seals.
 */
async function anchoredRegister({driver = fakeDriver()} = {}) {
  const repo = createMemoryRepo();
  let now = Date.parse('2026-10-11T08:00:00Z');
  const clock = () => new Date(now);
  clock.advance = ms => {
    now += ms;
  };
  const trail = new TrailService({repo, clock, logger: quiet});
  const tree = new TreeService({repo, clock, logger: quiet});
  const pending = [];
  const tap = event => {
    pending.push(trail.record(event).then(() => tree.fromEvent(event)));
  };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };

  const reg = await makeWithReview({tap});
  let r = await reg.service.createRecord(
    {edrmsDocumentId: reg.docs.grant.id},
    rec,
  );
  for (const k of ['t1996', 'sg', 't2008', 't2019']) {
    r = await reg.service.addDocument(
      r.id,
      {revision: r.draft.revision, edrmsDocumentId: reg.docs[k].id},
      rec,
    );
  }
  r = await reg.service.updateDraft(
    r.id,
    {
      revision: r.draft.revision,
      accept: ['owners', 'extent'],
      changes: {tenure: 'freehold', attributes: {zoning: 'Residential'}},
    },
    rec,
  );
  await reg.service.submit(r.id, {revision: r.draft.revision}, rec);
  const [task] = await reg.inbox(users.sup);
  assert.equal(
    (await reg.decide(users.sup, task.id, {outcome: 'approved'})).statusCode,
    200,
  );
  await settle();
  const record = await reg.service.getRecord(r.id);

  const {buildApp: buildEdrms} = await import('../../edrms/src/app.js');
  const edrmsApp = await buildEdrms({
    service: reg.edrmsService,
    jwtSecret: SECRET,
  });
  await edrmsApp.ready();
  const inject =
    app =>
    async (url, init = {}) => {
      const u = new URL(url);
      const res = await app.inject({
        method: init.method || 'GET',
        url: u.pathname + u.search,
        headers: init.headers,
        payload: init.body,
      });
      return {
        ok: res.statusCode < 400,
        status: res.statusCode,
        text: async () => res.body,
        json: async () => res.json(),
      };
    };
  const routed = (url, init) =>
    (url.includes('/records/') ? inject(reg.app) : inject(edrmsApp))(url, init);

  const cardano = createCardanoAdapter({
    driver,
    signer: createLocalSigner(),
    network: 'preview',
    logger: quiet,
  });
  const job = new AnchorService({
    repo,
    tree,
    cardano,
    logger: quiet,
    clock,
    config: {confirmations: 10},
  });
  const proofs = new ProofService({
    repo,
    tree,
    cardano,
    clock,
    logger: quiet,
    sources: createVerifySources({
      recordsUrl: 'http://records',
      edrmsUrl: 'http://edrms',
      serviceToken: asService('audit'),
      fetchImpl: routed,
    }),
  });
  const auditApp = await buildApp({service: trail, proofs, jwtSecret: SECRET});
  await auditApp.ready();

  /** Ticks a minute apart, a block a minute, until `until(result)`. */
  const runUntil = async (until, max = 60) => {
    for (let i = 0; i < max; i++) {
      const res = await job.tick();
      if (until(res)) return res;
      clock.advance(MINUTE);
      driver.chain.height += 1;
      driver.chain.slot += 60;
    }
    throw new Error('did not happen');
  };
  const doc = k => reg.docs[k];
  return {
    ...reg,
    repo,
    clock,
    trail,
    tree,
    settle,
    record,
    edrmsApp,
    auditApp,
    inject,
    routed,
    driver,
    chain: driver.chain,
    cardano,
    job,
    proofs,
    runUntil,
    doc,
  };
}

describe('proofs and verification (API-658)', () => {
  it('valid proofs pass: a land record version, a document version and a trail entry, against the anchoring on chain', async () => {
    const a = await anchoredRegister();
    await a.runUntil(x => x.action === 'confirmed');
    const [anchor] = a.repo.anchors;

    const rp = await a.proofs.proof('record-version', a.record.id, 1);
    assert.equal(rp.format, 'lrfe-audit-proof/1');
    assert.equal(rp.status, 'confirmed');
    assert.deepEqual(rp.item, {
      kind: 'record-version',
      recordId: a.record.id,
      version: 1,
      seal: a.record.current.seal,
    });
    assert.deepEqual([rp.tree.size, rp.tree.root], [anchor.size, anchor.root]);
    assert.deepEqual(
      [
        rp.anchor.tx,
        rp.anchor.network,
        rp.anchor.label,
        rp.anchor.block,
        rp.anchor.status,
      ],
      [anchor.txHash, 'preview', 8890, 100, 'confirmed'],
    );
    assert.ok(rp.anchor.confirmations >= 10);
    assert.equal(rp.anchor.address, await a.cardano.address());

    const v = await a.proofs.verify('record-version', a.record.id, 1);
    assert.equal(v.valid, true, JSON.stringify(v.checks));
    assert.deepEqual(
      [
        v.checks.item.source,
        v.checks.chain.source,
        v.checks.chain.metadata.root,
      ],
      ['land-records', 'test', anchor.root],
    );

    const d = await a.proofs.verify('document-version', a.doc('t2019').id, 1);
    assert.equal(d.valid, true, JSON.stringify(d.checks));
    assert.equal(d.checks.item.source, 'edrms');

    // a trail entry: the record's commit, with the chain from it to the anchored checkpoint
    const commit = a.repo.entries.find(
      e => e.type === 'records.record.committed',
    );
    const tp = await a.proofs.proof('trail-entry', String(commit.seq));
    assert.equal(tp.trail.entry.type, 'records.record.committed');
    assert.equal(tp.trail.checkpoint.seq, a.repo.entries.at(-1).seq);
    assert.equal(tp.trail.later.length, a.repo.entries.length - commit.seq);
    assert.equal(tp.leaf.key, `trail-checkpoint:${tp.trail.checkpoint.seq}`);
    assert.equal(
      (await a.proofs.verify('trail-entry', String(commit.seq))).valid,
      true,
    );
    assert.equal((await a.proofs.verify('trail-entry', '1')).valid, true);

    // the offline verifier, without the portal: through Koios and through Blockfrost
    for (const p of [rp, d.proof, tp]) {
      const koios = await verifyProof(clone(p), {
        address: await a.cardano.address(),
        fetchImpl: publicSource(a.driver),
      });
      assert.equal(koios.valid, true, JSON.stringify(koios.checks));
      assert.equal(koios.checks.at(-1).name, 'paid by the anchoring wallet');
      const bf = await verifyProof(clone(p), {
        source: 'blockfrost',
        key: 'preview-test-key',
        fetchImpl: publicSource(a.driver, {kind: 'blockfrost'}),
      });
      assert.equal(bf.valid, true, JSON.stringify(bf.checks));
      assert.equal(bf.anchoring.blockHeight, 100);
    }
  });

  it('a changed land record version, document version or trail entry fails', async () => {
    const a = await anchoredRegister();
    await a.runUntil(x => x.action === 'confirmed');

    // a land record version's data changed in the database after it was sealed
    const original = a.service.repo.listVersions.bind(a.service.repo);
    a.service.repo.listVersions = async id =>
      (await original(id)).map(v =>
        v.versionNumber === 1
          ? {...v, data: {...v.data, extent: {...v.data.extent, value: 9999}}}
          : v,
      );
    const rv = await a.proofs.verify('record-version', a.record.id, 1);
    assert.equal(rv.valid, false);
    assert.deepEqual(
      [
        rv.checks.item.ok,
        rv.checks.item.problem,
        rv.checks.path.ok,
        rv.checks.chain.ok,
      ],
      [false, "the version's data no longer matches its seal", true, true],
    );
    a.service.repo.listVersions = original;

    // a document version's verified fields changed in the database
    const getVersion = a.edrmsService.repo.getVersion.bind(a.edrmsService.repo);
    a.edrmsService.repo.getVersion = async (id, n) => {
      const ver = await getVersion(id, n);
      return id === a.doc('t2019').id
        ? {...ver, fields: {...ver.fields, titleDeedNo: 'T9999/2019'}}
        : ver;
    };
    const dv = await a.proofs.verify('document-version', a.doc('t2019').id, 1);
    assert.deepEqual(
      [dv.valid, dv.checks.item.ok, dv.checks.item.source],
      [false, false, 'edrms'],
    );
    assert.equal(
      (await a.proofs.verify('document-version', a.doc('grant').id, 1)).valid,
      true,
    );

    // a trail entry changed in the audit database: in the service and in the offline verifier
    const commit = a.repo.entries.find(
      e => e.type === 'records.record.committed',
    );
    const good = await a.proofs.proof('trail-entry', String(commit.seq));
    commit.data = {...commit.data, approvedByName: 'Someone Else'};
    const tv = await a.proofs.verify('trail-entry', String(commit.seq));
    assert.deepEqual(
      [tv.valid, tv.checks.item.problem],
      [false, 'the entry was changed after it was recorded'],
    );
    const forged = clone(good);
    forged.trail.entry.data.approvedByName = 'Someone Else';
    const off = await verifyProof(forged, {fetchImpl: publicSource(a.driver)});
    assert.equal(off.valid, false);
    assert.equal(off.checks.find(c => c.name === 'trail entry').ok, false);
    // an entry rewritten with fresh hashes no longer leads to the anchored checkpoint
    const {contentHash, chainHash} = await import('../src/chain.js');
    forged.trail.entry.contentHash = contentHash(forged.trail.entry);
    forged.trail.entry.hash = chainHash(
      forged.trail.entry.prevHash,
      forged.trail.entry.contentHash,
    );
    const rehashed = await verifyProof(forged, {
      fetchImpl: publicSource(a.driver),
    });
    assert.deepEqual(
      rehashed.checks.filter(c => !c.ok).map(c => c.name),
      ['trail chain to the checkpoint'],
    );

    // a seal changed in a proof file: the leaf and path no longer reach the anchored root
    const rp = await a.proofs.proof('record-version', a.record.id, 1);
    const changedSeal = clone(rp);
    changedSeal.item.seal = changedSeal.leaf.item = createHash('sha256')
      .update('another version')
      .digest('hex');
    const cs = await verifyProof(changedSeal, {
      fetchImpl: publicSource(a.driver),
    });
    assert.deepEqual(
      cs.checks.filter(c => !c.ok).map(c => c.name),
      ['leaf', 'path to the root'],
    );
  });

  it('a wrong path, and a root that is not in the transaction, fail', async () => {
    const a = await anchoredRegister();
    await a.runUntil(x => x.action === 'confirmed');
    const p = await a.proofs.proof('document-version', a.doc('sg').id, 1);
    assert.ok(p.tree.path.length > 0);

    const wrongPath = clone(p);
    wrongPath.tree.path[0] = createHash('sha256')
      .update('not the sibling')
      .digest('hex');
    const wp = await verifyProof(wrongPath, {
      fetchImpl: publicSource(a.driver),
    });
    assert.deepEqual(
      wp.checks.filter(c => !c.ok).map(c => c.name),
      ['path to the root'],
    );
    const shortPath = clone(p);
    shortPath.tree.path.pop();
    assert.equal(
      (await verifyProof(shortPath, {fetchImpl: publicSource(a.driver)})).valid,
      false,
    );
    const otherLeaf = clone(p);
    otherLeaf.leaf.index = (p.leaf.index + 1) % p.tree.size;
    assert.equal(
      (await verifyProof(otherLeaf, {fetchImpl: publicSource(a.driver)})).valid,
      false,
    );

    // a whole other tree (consistent in itself) whose root is not the one on chain
    const other = createMemoryRepo();
    const otherTree = new TreeService({repo: other, logger: quiet});
    await otherTree.append(
      a.repo.leaves
        .map(l => ({key: l.key, type: l.type, item: l.item}))
        .concat([
          {key: 'document-version:x:1', type: 2, item: 'ab'.repeat(32)},
        ]),
    );
    const op = await otherTree.inclusionProof(p.leaf.key);
    const notOnChain = {
      ...clone(p),
      leaf: {...p.leaf, index: op.leaf.index, hash: op.leaf.hash},
      tree: {size: op.size, path: op.path, peaks: op.peaks, root: op.root},
    };
    const nc = await verifyProof(notOnChain, {
      fetchImpl: publicSource(a.driver),
    });
    assert.deepEqual(
      nc.checks.filter(c => !c.ok).map(c => c.name),
      ['root in the transaction'],
    );

    // the chain holds another root for the transaction: the service's check fails too
    a.driver.metadata = async () => ({
      [LABEL]: {
        v: 1,
        sys: 'lrfe-audit',
        root: 'cd'.repeat(32),
        size: p.tree.size,
        batch: 1,
      },
    });
    const v = await a.proofs.verify('document-version', a.doc('sg').id, 1);
    assert.deepEqual(
      [v.valid, v.checks.chain.ok, v.checks.chain.problem],
      [false, false, "the root in the transaction is not this proof's root"],
    );
    a.driver.metadata = async () => null;
    assert.equal(
      (await a.proofs.verify('document-version', a.doc('sg').id, 1)).checks
        .chain.problem,
      'the transaction carries no anchoring metadata',
    );
    const output = a.driver.output;
    a.driver.output = async () => ({onChain: false, blockHeight: null});
    assert.equal(
      (await a.proofs.verify('document-version', a.doc('sg').id, 1)).checks
        .chain.problem,
      'the transaction is not on the chain',
    );
    a.driver.output = output;
    // a transaction that is not on the chain at all, read by the offline verifier
    const gone = clone(p);
    gone.anchor.tx = 'ef'.repeat(32);
    assert.deepEqual(
      (await verifyProof(gone, {fetchImpl: publicSource(a.driver)})).checks
        .filter(c => !c.ok)
        .map(c => c.name),
      ['transaction on chain'],
    );
  });

  it('with the own node (no index of past transactions) the root is checked in the stored signed transaction', async () => {
    const driver = fakeDriver();
    driver.metadata = null; // like Ogmios: no index of past transactions,
    const output = driver.output; // and no block height for a transaction
    driver.output = async id => ({...(await output(id)), blockHeight: null});
    const a = await anchoredRegister({driver});
    await a.runUntil(x => x.action === 'confirmed');
    const v = await a.proofs.verify('record-version', a.record.id, 1);
    assert.equal(v.valid, true, JSON.stringify(v.checks));
    assert.equal(v.checks.chain.source, 'stored');
    assert.equal(v.proof.anchor.blockIs, 'firstSeen');
    // the stored transaction changed (another root put in its metadata): its id no longer matches
    const [row] = a.repo.anchors;
    const {buildAnchorTx, anchorMetadata} =
      await import('../src/cardano/tx.js');
    const signer = createLocalSigner();
    const {PARAMS} = await import('./helpers.js');
    const forged = buildAnchorTx({
      utxos: [
        {
          txHash: row.inputTxHash,
          index: row.inputIndex,
          lovelace: '10000000000',
          assets: false,
        },
      ],
      address: await a.cardano.address(),
      publicKey: await signer.publicKey(),
      params: PARAMS,
      metadata: anchorMetadata({
        root: 'cd'.repeat(32),
        size: row.size,
        batch: 1,
      }),
      ttl: row.ttl,
    });
    row.cbor = forged.sign(await signer.sign(forged.bodyHash)).cbor;
    const f = await a.proofs.verify('record-version', a.record.id, 1);
    assert.deepEqual(
      [f.valid, f.checks.chain.ok, f.checks.chain.problem],
      [
        false,
        false,
        "the stored transaction is not signed by the anchoring wallet or does not carry this proof's root",
      ],
    );
  });

  it('status: waiting for the next anchoring, anchored, confirmed; entries after the last checkpoint wait', async () => {
    const driver = fakeDriver();
    driver.chain.mempool = true;
    const a = await anchoredRegister({driver});
    const key = `record-version:${a.record.id}:1`;
    const before = await a.proofs.proof('record-version', a.record.id, 1);
    assert.deepEqual([before.status, before.anchor], ['waiting', null]);
    assert.equal(before.tree.size, await a.tree.size()); // against the tree as it is now
    const w = await a.proofs.verify('record-version', a.record.id, 1);
    assert.deepEqual(
      [w.valid, w.status, w.checks.item.ok, w.checks.path.ok, w.checks.chain],
      [false, 'waiting', true, true, null],
    );
    assert.deepEqual(await a.proofs.statusOf([key]), {
      [key]: {status: 'waiting'},
    });
    const off = await verifyProof(
      clone(await a.proofs.proof('trail-entry', '1')),
      {fetchImpl: publicSource(a.driver)},
    );
    assert.deepEqual([off.valid, off.checks[0].name], [false, 'anchored']);

    assert.equal((await a.job.tick()).action, 'anchored'); // sent, waiting in the mempool
    const sent = (await a.proofs.statusOf([key]))[key];
    assert.deepEqual(
      [sent.status, sent.batch, sent.tx],
      ['anchored', 1, a.repo.anchors[0].txHash],
    );
    assert.equal(
      (await a.proofs.proof('record-version', a.record.id, 1)).anchor.status,
      'submitted',
    );
    a.chain.include();
    a.chain.mempool = false;
    await a.runUntil(x => x.action === 'confirmed');
    assert.equal((await a.proofs.statusOf([key]))[key].status, 'confirmed');
    assert.deepEqual(
      await a.proofs.statusOf([
        'record-version:00000000-0000-4000-8000-000000000000:1',
      ]),
      {'record-version:00000000-0000-4000-8000-000000000000:1': null},
    );

    // an event after the anchoring: its trail entry waits for the next checkpoint, then is covered
    await a.trail.record({
      id: 'ev-after',
      type: 'identity.user.invited',
      source: 'identity',
      time: a.clock().toISOString(),
      actor: {id: 'u1', name: 'Admin'},
      data: {userId: 'u7'},
    });
    const last = a.repo.entries.at(-1);
    assert.equal(
      (await a.proofs.proof('trail-entry', String(last.seq))).status,
      'waiting',
    );
    a.clock.advance(HOUR);
    await a.runUntil(x => x.action === 'confirmed');
    const covered = await a.proofs.proof('trail-entry', String(last.seq));
    assert.deepEqual(
      [
        covered.status,
        covered.anchor.batch,
        covered.trail.checkpoint.seq,
        covered.trail.later,
      ],
      ['confirmed', 2, last.seq, []],
    );
    assert.equal(
      (await a.proofs.verify('trail-entry', String(last.seq))).valid,
      true,
    );
    // an entry from before keeps its proof against the first anchoring
    assert.equal((await a.proofs.proof('trail-entry', '1')).anchor.batch, 1);
  });

  it('a root put on chain by another wallet does not pass: the anchoring wallet must have paid for the transaction', async () => {
    const a = await anchoredRegister();
    await a.runUntil(x => x.action === 'confirmed');
    const wallet = await a.cardano.address();
    const p = await a.proofs.proof('record-version', a.record.id, 1);
    // a forger's own tree with a made-up seal for this version, its root put on chain from their wallet
    const forger = createLocalSigner();
    const other = new TreeService({repo: createMemoryRepo(), logger: quiet});
    await other.append([
      {key: p.leaf.key, type: 1, item: 'ee'.repeat(32)},
      {key: 'document-version:y:1', type: 2, item: 'ab'.repeat(32)},
    ]);
    const op = await other.inclusionProof(p.leaf.key);
    const utxo = a.chain.topUp();
    const tx = buildAnchorTx({
      utxos: [utxo],
      address: addressOf(await forger.publicKey(), 'preview'),
      publicKey: await forger.publicKey(),
      params: PARAMS,
      metadata: anchorMetadata({root: op.root, size: op.size, batch: 1}),
      ttl: a.chain.slot + 3600,
      input: {txHash: utxo.txHash, index: utxo.index},
    });
    const txHash = await a.driver.submit(
      tx.sign(await forger.sign(tx.bodyHash)).cbor,
    );
    const forged = {
      ...clone(p),
      item: {...p.item, seal: 'ee'.repeat(32)},
      leaf: {
        ...p.leaf,
        item: 'ee'.repeat(32),
        index: op.leaf.index,
        hash: op.leaf.hash,
      },
      tree: {size: op.size, path: op.path, peaks: op.peaks, root: op.root},
      anchor: {...p.anchor, tx: txHash, root: op.root, size: op.size},
    };
    const r = await verifyProof(clone(forged), {
      fetchImpl: publicSource(a.driver),
    });
    assert.deepEqual(
      r.checks.filter(c => !c.ok).map(c => c.name),
      ['paid by the anchoring wallet'],
    );
    // naming the forger's wallet in the proof passes only until the published address is given
    forged.anchor.address = addressOf(await forger.publicKey(), 'preview');
    assert.equal(
      (await verifyProof(clone(forged), {fetchImpl: publicSource(a.driver)}))
        .valid,
      true,
    );
    const pinned = await verifyProof(clone(forged), {
      address: wallet,
      fetchImpl: publicSource(a.driver),
    });
    assert.deepEqual(
      [pinned.valid, pinned.checks.at(-1).detail],
      [
        false,
        `the proof's wallet ${forged.anchor.address} is not the given address ${wallet}`,
      ],
    );
    assert.ok(
      (
        await verifyProof(clone(p), {fetchImpl: publicSource(a.driver)})
      ).notes.some(n => n.includes(wallet)),
    );
    // the trail chain must be exactly as long as the checkpoint says
    const t = await a.proofs.proof('trail-entry', '1');
    const shortened = clone(t);
    shortened.trail.checkpoint.seq += 1;
    assert.deepEqual(
      (await verifyProof(shortened, {fetchImpl: publicSource(a.driver)})).checks
        .filter(c => !c.ok)
        .map(c => c.name),
      ['trail chain to the checkpoint'],
    );
  });

  it('proofs use the first anchoring sent that covers the item: never a prepared or refused one; its replacement and checkpoint instead', async () => {
    const a = await anchoredRegister();
    const key = `record-version:${a.record.id}:1`;
    // a prepared anchoring (built, not yet sent) covers nothing yet
    a.repo.anchors.push({
      batch: 99,
      status: 'prepared',
      size: 1000,
      checkpointSeq: 1000,
      root: 'ab'.repeat(32),
      network: 'preview',
      txHash: 'cd'.repeat(32),
    });
    assert.equal(
      (await a.proofs.proof('record-version', a.record.id, 1)).status,
      'waiting',
    );
    assert.equal((await a.proofs.proof('trail-entry', '1')).status, 'waiting');
    a.repo.anchors.pop();
    // the chain refuses the first anchoring; the replacement, a few minutes later, lands
    a.chain.reject = new CardanoError(
      'The chain refused the transaction: test',
      'EREJECTED',
    );
    assert.equal((await a.job.tick()).action, 'refused');
    assert.deepEqual(await a.proofs.statusOf([key]), {
      [key]: {status: 'waiting'},
    });
    assert.equal((await a.proofs.proof('trail-entry', '2')).status, 'waiting');
    a.chain.reject = null;
    a.clock.advance(6 * MINUTE);
    await a.runUntil(x => x.action === 'confirmed');
    assert.deepEqual(
      a.repo.anchors.map(x => [x.batch, x.status]),
      [
        [1, 'failed'],
        [2, 'confirmed'],
      ],
    );
    const p = await a.proofs.proof('record-version', a.record.id, 1);
    assert.deepEqual(
      [p.status, p.anchor.batch, p.tree.root],
      ['confirmed', 2, a.repo.anchors[1].root],
    );
    const t = await a.proofs.proof('trail-entry', '2');
    assert.deepEqual(
      [t.anchor.batch, t.trail.checkpoint.seq],
      [2, a.repo.anchors[1].checkpointSeq],
    );
    for (const proof of [p, t]) {
      assert.equal(
        (await verifyProof(clone(proof), {fetchImpl: publicSource(a.driver)}))
          .valid,
        true,
      );
    }
  });

  it('verify says when the owning service cannot be reached, instead of failing', async () => {
    const a = await anchoredRegister();
    await a.runUntil(x => x.action === 'confirmed');
    a.proofs.sources = {
      recordVersion: async () => {
        throw new AppError(
          503,
          'The land records service cannot be reached: ECONNREFUSED',
        );
      },
    };
    const v = await a.proofs.verify('record-version', a.record.id, 1);
    assert.deepEqual(
      [v.valid, v.checks.item.ok, v.checks.path.ok, v.checks.chain.ok],
      [false, null, true, true],
    );
    assert.match(v.checks.item.problem, /could not be recomputed now/);
    const bad = createVerifySources({
      recordsUrl: 'http://records',
      edrmsUrl: 'http://edrms',
      serviceToken: () => 't',
      fetchImpl: async () => ({
        status: 502,
        text: async () => '<html>Bad gateway</html>',
      }),
    });
    await assert.rejects(
      bad.documentVersion(a.doc('sg').id, 1),
      /could not check the version \(502\)/,
    );
  });

  it("the offline verifier's tree arithmetic agrees with the service's for every leaf of trees up to 70 leaves", async () => {
    const repo = createMemoryRepo();
    const tree = new TreeService({repo, logger: quiet});
    for (let n = 1; n <= 70; n++) {
      await tree.append([
        {
          key: `document-version:d${n}:1`,
          type: 2,
          item: createHash('sha256').update(`s${n}`).digest('hex'),
        },
      ]);
      for (let i = 0; i < n; i++) {
        const p = await tree.inclusionProof(`document-version:d${i + 1}:1`, n);
        assert.equal(
          checkInclusion({
            leaf: p.leaf.hash,
            index: i,
            size: n,
            path: p.path,
            peaks: p.peaks,
            root: p.root,
          }),
          true,
          `leaf ${i} of ${n}`,
        );
        // the same proof for the neighbouring leaf fails
        if (n > 1) {
          assert.equal(
            checkInclusion({
              leaf: p.leaf.hash,
              index: (i + 1) % n,
              size: n,
              path: p.path,
              peaks: p.peaks,
              root: p.root,
            }),
            false,
            `leaf ${i} as ${(i + 1) % n} of ${n}`,
          );
        }
      }
    }
  });

  it("over HTTP: proofs and verify for auditors; the anchoring status in land-records' history and in edrms' documents", async () => {
    const a = await anchoredRegister();
    await a.runUntil(x => x.action === 'confirmed');
    const token = perms => ({
      authorization: `Bearer ${a.auditApp.jwt.sign({typ: 'access', sub: 'u9', name: 'Auditor', perms})}`,
    });
    const auditor = token(['audit.view', 'record.view']);

    const p = await a.auditApp.inject({
      url: `/audit/proofs/record-version/${a.record.id}?version=1`,
      headers: auditor,
    });
    assert.equal(p.statusCode, 200);
    assert.equal(p.json().status, 'confirmed');
    assert.equal(
      (
        await a.auditApp.inject({
          url: `/audit/proofs/record-version/${a.record.id}?version=1`,
          headers: token(['record.view']),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await a.auditApp.inject({
          url: `/audit/proofs/record-version/${a.record.id}`,
          headers: auditor,
        })
      ).statusCode,
      400,
    ); // which version
    assert.equal(
      (
        await a.auditApp.inject({
          url: '/audit/proofs/record-version/not-a-uuid?version=1',
          headers: auditor,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await a.auditApp.inject({
          url: `/audit/proofs/record-version/${a.record.id}?version=7`,
          headers: auditor,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await a.auditApp.inject({
          url: '/audit/proofs/trail-entry/99999',
          headers: auditor,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await a.auditApp.inject({
          url: '/audit/proofs/parcel/1',
          headers: auditor,
        })
      ).statusCode,
      400,
    );
    const v = await a.auditApp.inject({
      method: 'POST',
      url: '/audit/verify',
      headers: auditor,
      payload: {kind: 'document-version', id: a.doc('t1996').id, version: 1},
    });
    assert.equal(v.statusCode, 200);
    assert.equal(v.json().valid, true);

    // the anchoring status is for land-records and edrms only
    const keys = [`record-version:${a.record.id}:1`];
    assert.equal(
      (
        await a.auditApp.inject({
          method: 'POST',
          url: '/audit/anchoring',
          headers: {authorization: `Bearer ${asService('land-records')()}`},
          payload: {keys},
        })
      ).json().items[keys[0]].status,
      'confirmed',
    );
    assert.equal(
      (
        await a.auditApp.inject({
          method: 'POST',
          url: '/audit/anchoring',
          headers: {authorization: `Bearer ${asService('bpm')()}`},
          payload: {keys},
        })
      ).statusCode,
      403,
    );
    assert.ok(
      [401, 403].includes(
        (
          await a.auditApp.inject({
            method: 'POST',
            url: '/audit/anchoring',
            headers: auditor,
            payload: {keys},
          })
        ).statusCode,
      ),
    );
    assert.equal(
      (
        await a.auditApp.inject({
          method: 'POST',
          url: '/audit/anchoring',
          headers: {authorization: `Bearer ${asService('edrms')()}`},
          payload: {keys: ['record-version:x:1']},
        })
      ).statusCode,
      400,
    );

    // land-records and edrms ask the audit service (best effort)
    a.service.anchoring = createAnchoringClient({
      baseUrl: 'http://audit',
      serviceToken: asService('land-records'),
      fetchImpl: a.inject(a.auditApp),
      logger: quiet,
    });
    const history = (
      await a.app.inject({
        url: `/records/${a.record.id}/history`,
        headers: a.as(users.sup),
      })
    ).json();
    assert.deepEqual(
      [
        history.versions[0].anchoring.status,
        history.versions[0].anchoring.batch,
      ],
      ['confirmed', 1],
    );
    a.edrmsService.anchoring = createAnchoringClient({
      baseUrl: 'http://audit',
      serviceToken: asService('edrms'),
      fetchImpl: a.inject(a.auditApp),
      logger: quiet,
    });
    const asUser = {
      authorization: `Bearer ${a.edrmsApp.jwt.sign({typ: 'access', sub: 'u3', name: 'Records Officer', perms: ['record.view']})}`,
    };
    const docBody = (
      await a.edrmsApp.inject({
        url: `/documents/${a.doc('sg').id}`,
        headers: asUser,
      })
    ).json();
    assert.equal(docBody.versions[0].anchoring.status, 'confirmed');
    const forService = (
      await a.edrmsApp.inject({
        url: `/documents/${a.doc('sg').id}`,
        headers: {authorization: `Bearer ${asService('land-records')()}`},
      })
    ).json();
    assert.equal('anchoring' in forService.versions[0], false); // services reading documents skip the call
    // the audit service down: no status, nothing else held up
    a.service.anchoring = createAnchoringClient({
      baseUrl: 'http://audit',
      serviceToken: asService('land-records'),
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      logger: quiet,
    });
    const without = await a.app.inject({
      url: `/records/${a.record.id}/history`,
      headers: a.as(users.sup),
    });
    assert.deepEqual(
      [without.statusCode, without.json().versions[0].anchoring],
      [200, null],
    );

    // the owning services' seal checks: the audit service and auditors only
    assert.equal(
      (
        await a.app.inject({
          url: `/records/${a.record.id}/verify`,
          headers: {authorization: `Bearer ${asService('audit')()}`},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await a.app.inject({
          url: `/records/${a.record.id}/verify`,
          headers: {authorization: `Bearer ${asService('bpm')()}`},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await a.edrmsApp.inject({
          url: `/documents/${a.doc('sg').id}/versions/1/verify`,
          headers: {authorization: `Bearer ${asService('audit')()}`},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await a.edrmsApp.inject({
          url: `/documents/${a.doc('sg').id}/versions/1/verify`,
          headers: {authorization: `Bearer ${asService('intake')()}`},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await a.edrmsApp.inject({
          url: `/documents/${a.doc('sg').id}/versions/1/verify`,
          headers: asUser,
        })
      ).statusCode,
      403,
    );
  });
});

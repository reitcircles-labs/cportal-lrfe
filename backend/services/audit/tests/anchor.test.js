import {strict as assert} from 'node:assert';
import {createHash, randomUUID} from 'node:crypto';
import {AnchorService, parsePeriod} from '../src/anchor.service.js';
import {TrailService} from '../src/trail.service.js';
import {TreeService} from '../src/tree.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {createCardanoAdapter} from '../src/cardano/adapter.js';
import {createLocalSigner} from '../src/cardano/signer.js';
import {CardanoError, readAnchorMetadata} from '../src/cardano/tx.js';
import {verifyConsistency, verifyInclusion} from '../src/mmr.js';
import {fakeDriver} from './helpers.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const quiet = {info() {}, warn() {}, error() {}};
const seal = n => createHash('sha256').update(`seal ${n}`).digest('hex');

/** The audit service with the fake chain: trail, tree, adapter and the job, on one clock. */
function makeAudit({
  repo = createMemoryRepo(),
  driver = fakeDriver(),
  holder,
} = {}) {
  let now = Date.parse('2026-10-11T08:00:00Z');
  const clock = () => new Date(now);
  clock.advance = ms => {
    now += ms;
  };
  const published = [];
  const events = {
    publish: async (type, data, o) => {
      published.push({type, data, o});
    },
  };
  const trail = new TrailService({repo, clock, logger: quiet});
  const tree = new TreeService({repo, clock, logger: quiet});
  const cardano = createCardanoAdapter({
    driver,
    signer: createLocalSigner(),
    network: 'preview',
    logger: quiet,
    events,
  });
  const errors = [];
  const job = new AnchorService({
    repo,
    tree,
    cardano,
    events,
    logger: {...quiet, error: (o, m) => errors.push([o, m])},
    clock,
    config: {confirmations: 10, holder},
  });
  let n = 0;
  /** What the consumer does with an event: a trail entry and, for a seal, a leaf. */
  const record = async (type, data) => {
    const event = {
      id: randomUUID(),
      type,
      source: type.split('.')[0],
      time: clock().toISOString(),
      actor: {id: 'u1', name: 'Tester'},
      data,
    };
    await trail.record(event);
    await tree.fromEvent(event);
  };
  const fileDocument = () =>
    record('edrms.document.filed', {documentId: `d${++n}`, seal: seal(n)});
  /** Ticks a minute apart, the chain growing a block each, until `until(result)`. */
  const runUntil = async (until, max = 60) => {
    for (let i = 0; i < max; i++) {
      const r = await job.tick();
      if (until(r)) return r;
      clock.advance(MINUTE);
      driver.chain.height += 1;
      driver.chain.slot += 60;
    }
    throw new Error('did not happen');
  };
  /** Let `ms` pass: the clock and the chain's slots (a block a minute). */
  const pass = ms => {
    clock.advance(ms);
    driver.chain.slot += Math.round(ms / 1000);
    driver.chain.height += Math.round(ms / MINUTE);
  };
  return {
    repo,
    driver,
    chain: driver.chain,
    clock,
    pass,
    published,
    errors,
    trail,
    tree,
    cardano,
    job,
    record,
    fileDocument,
    runUntil,
  };
}

describe('hourly anchoring (API-657)', () => {
  it('a batch with new leaves is anchored once, followed to 10 blocks deep and confirmed', async () => {
    const a = makeAudit();
    for (let i = 0; i < 3; i++) await a.fileDocument();
    const first = await a.job.tick();
    assert.equal(first.action, 'anchored');
    assert.equal(a.chain.submitted.length, 1);
    const meta = readAnchorMetadata(a.chain.submitted[0].cbor);
    const {root, size} = await a.tree.root();
    assert.deepEqual(
      [meta.root, meta.size, meta.batch, meta.prev],
      [root, size, 1, undefined],
    );
    assert.equal(size, 4); // 3 documents + the trail checkpoint
    assert.equal(a.published[0].type, 'audit.root.anchored');
    assert.deepEqual(a.published[0].o, {durable: false}); // never in the trail: no anchoring causes the next

    const r = await a.runUntil(x => x.action === 'confirmed');
    assert.equal(r.batch, 1);
    assert.equal(a.chain.submitted.length, 1); // followed, never sent twice
    const [anchor] = a.repo.anchors;
    assert.equal(anchor.status, 'confirmed');
    assert.equal(anchor.firstSeenHeight, 100);
    // for the Anchorings screens (API-671): when it reached the blockchain, and its depth
    assert.ok(
      anchor.onChainAt instanceof Date &&
        anchor.onChainAt <= anchor.confirmedAt,
    );
    assert.equal(anchor.confirmations, 10);
    assert.equal(a.published.at(-1).type, 'audit.root.confirmed');
    assert.equal(a.published.at(-1).data.depth, 10);
    assert.equal((await a.trail.list()).total, 3); // the job wrote nothing to the trail
  });

  it('an hour with nothing new is skipped; the next hour with news is anchored, chained to the last root', async () => {
    const a = makeAudit();
    await a.fileDocument();
    await a.job.tick();
    await a.runUntil(x => x.action === 'confirmed');
    assert.equal((await a.job.tick()).action, 'waiting for the period');
    a.clock.advance(HOUR);
    assert.equal((await a.job.tick()).action, 'nothing new');
    assert.equal(a.chain.submitted.length, 1);
    a.clock.advance(HOUR);
    assert.equal((await a.job.tick()).action, 'nothing new');
    await a.fileDocument();
    const r = await a.job.tick();
    assert.equal(r.action, 'anchored');
    const meta = readAnchorMetadata(a.chain.submitted[1].cbor);
    assert.equal(meta.batch, 2);
    assert.equal(meta.prev, a.repo.anchors[0].root);
  });

  it('trail entries without a seal (a sign-off, a finding) are anchored too, through the checkpoint', async () => {
    const a = makeAudit();
    await a.fileDocument();
    await a.job.tick();
    await a.runUntil(x => x.action === 'confirmed');
    a.clock.advance(HOUR);
    await a.record('audit.signoff.recorded', {
      recordId: 'r1',
      conclusion: 'in order',
    });
    assert.equal((await a.job.tick()).action, 'anchored');
    const second = a.repo.anchors[1];
    assert.equal(second.checkpointSeq, (await a.repo.head()).seq);
    assert.equal(second.size, a.repo.anchors[0].size + 1); // only the new checkpoint leaf
  });

  it('a send that fails is sent again at the next round: still one anchoring', async () => {
    const a = makeAudit();
    await a.fileDocument();
    a.chain.fail = new CardanoError(
      'Blockfrost is unreachable: timeout',
      'EUNAVAILABLE',
    );
    assert.equal((await a.job.tick()).action, 'not prepared'); // could not even read the wallet
    a.chain.fail = null;
    a.driver.submit = (submit => {
      let first = true;
      return async cbor => {
        if (first) {
          first = false;
          throw new CardanoError(
            'Blockfrost failed submit: HTTP 502',
            'EUNAVAILABLE',
          );
        }
        return submit(cbor);
      };
    })(a.driver.submit.bind(a.driver));
    assert.equal((await a.job.tick()).action, 'send failed, retried later');
    assert.equal(a.repo.anchors[0].status, 'prepared');
    a.clock.advance(MINUTE);
    assert.equal((await a.job.tick()).action, 'anchored');
    assert.equal(a.repo.anchors.length, 1);
    assert.equal(a.chain.submitted.length, 1);
    assert.equal(
      a.published.filter(p => p.type === 'audit.root.anchored').length,
      1,
    );
  });

  it('a reply lost after the chain took it: sending again is refused, the job sees it on chain, no second anchoring', async () => {
    const a = makeAudit();
    await a.fileDocument();
    a.chain.lostReply = true;
    assert.equal((await a.job.tick()).action, 'send failed, retried later');
    assert.equal(a.chain.submitted.length, 1); // it did get there
    a.clock.advance(MINUTE);
    assert.equal((await a.job.tick()).action, 'already on chain');
    await a.runUntil(x => x.action === 'confirmed');
    assert.equal(a.chain.submitted.length, 1);
    assert.equal(a.repo.anchors.length, 1);
  });

  it('each anchoring transaction is valid for an hour (its last slot is stored with it)', async () => {
    const a = makeAudit();
    await a.fileDocument();
    await a.job.tick();
    const C = (await import('@emurgo/cardano-serialization-lib-nodejs'))
      .default;
    const ttl = Number(
      C.Transaction.from_hex(a.repo.anchors[0].cbor)
        .body()
        .ttl_bignum()
        .to_str(),
    );
    assert.equal(ttl, 2000 + 3600);
    assert.equal(a.repo.anchors[0].ttl, ttl);
  });

  it('the reply is lost while the transaction waits in the mempool: sending again is refused, it is not given up, still one anchoring', async () => {
    const a = makeAudit();
    a.chain.mempool = true;
    await a.fileDocument();
    a.chain.lostReply = true;
    assert.equal((await a.job.tick()).action, 'send failed, retried later');
    a.pass(MINUTE);
    // the node already has it: the repeat is refused (its input is spent in the mempool), and the
    // ledger does not show it yet. Before the fix this was marked failed and anchored again.
    assert.equal((await a.job.tick()).action, 'refused again, waiting');
    assert.equal(a.repo.anchors[0].status, 'submitted');
    for (let i = 0; i < 10; i++) {
      a.pass(MINUTE);
      assert.equal((await a.job.tick()).inFlight, true);
    }
    assert.equal(a.repo.anchors.length, 1); // no second anchoring meanwhile
    a.chain.include();
    await a.runUntil(x => x.action === 'confirmed');
    assert.equal(a.repo.anchors.length, 1);
    assert.equal(a.chain.blocks.length, 1);
    assert.equal(
      a.published.filter(p => p.type === 'audit.root.anchored').length,
      1,
    );
  });

  it('a transaction the mempool forgot is sent again every 5 minutes until it lands', async () => {
    const a = makeAudit();
    a.chain.mempool = true;
    await a.fileDocument();
    assert.equal((await a.job.tick()).action, 'anchored');
    a.chain.dropMempool();
    a.pass(MINUTE);
    assert.equal((await a.job.tick()).action, 'waiting for the chain');
    a.pass(5 * MINUTE);
    assert.equal((await a.job.tick()).action, 'sent again');
    a.chain.include();
    await a.runUntil(x => x.action === 'confirmed');
    assert.equal(a.repo.anchors.length, 1);
  });

  it('a rollback sends the same transaction again: back in the mempool or gone, it lands once', async () => {
    for (const toMempool of [true, false]) {
      const a = makeAudit();
      await a.fileDocument();
      await a.job.tick();
      a.pass(3 * MINUTE);
      assert.equal((await a.job.tick()).action, 'waiting for confirmations');
      a.chain.mempool = true;
      a.chain.rollback(a.repo.anchors[0].txHash, {toMempool});
      const r = await a.job.tick();
      assert.equal(r.action, 'rolled back, sent again');
      assert.equal(a.repo.anchors[0].status, 'submitted');
      assert.deepEqual(
        [a.repo.anchors[0].onChainAt, a.repo.anchors[0].confirmations],
        [null, null],
      );
      a.chain.include();
      await a.runUntil(x => x.action === 'confirmed');
      assert.equal(
        a.repo.anchors.length,
        1,
        toMempool ? 'back in the mempool' : 'gone',
      );
      assert.equal(a.chain.blocks.length, 1);
    }
  });

  it('given up only once the chain is 10 blocks past its limit without it; the replacement spends the same output', async () => {
    const a = makeAudit();
    a.chain.mempool = true;
    await a.fileDocument();
    await a.job.tick();
    const first = a.repo.anchors[0];
    // never included: followed, and sent again, for the whole hour it is valid
    for (let m = 0; m < 59; m++) {
      a.pass(MINUTE);
      assert.equal((await a.job.tick()).inFlight, true, `minute ${m + 1}`);
    }
    a.pass(2 * MINUTE); // now past its limit (the node drops it)
    assert.equal((await a.job.tick()).action, 'expired, making sure');
    for (let b = 1; b < 10; b++) {
      a.pass(MINUTE);
      assert.equal(
        (await a.job.tick()).action,
        'expired, making sure',
        `block ${b}`,
      );
    }
    a.pass(MINUTE);
    const r = await a.job.tick();
    assert.deepEqual([r.after, r.action], ['expired', 'anchored']); // given up and replaced in the same round
    assert.equal(a.repo.anchors[0].status, 'failed');
    assert.equal(a.repo.anchors[0].reason, 'expired');
    assert.ok(a.repo.anchors[0].failedAt instanceof Date);
    const second = a.repo.anchors[1];
    assert.equal(second.root, first.root);
    assert.deepEqual(
      [second.inputTxHash, second.inputIndex],
      [first.inputTxHash, first.inputIndex],
    );
    await assert.rejects(a.driver.submit(first.cbor), e =>
      /OutsideValidityInterval/.test(e.message),
    );
    a.chain.include();
    await a.runUntil(x => x.action === 'confirmed');
    assert.equal(a.chain.blocks.length, 1);
  });

  it('the replacement spends the replaced output even when a larger one exists (a top-up): both can never land', async () => {
    const a = makeAudit();
    a.chain.mempool = true;
    await a.fileDocument();
    await a.job.tick();
    const first = a.repo.anchors[0];
    a.chain.topUp('90000000000'); // larger than the original output
    a.pass(62 * MINUTE);
    await a.runUntil(x => x.action === 'anchored');
    const second = a.repo.anchors[1];
    assert.deepEqual(
      [second.inputTxHash, second.inputIndex],
      [first.inputTxHash, first.inputIndex],
    );
    assert.notEqual(second.inputTxHash, a.chain.ledger.at(-1).txHash);
  });

  it('a given-up anchoring that lands after all (a fork) is followed again, not replaced', async () => {
    const a = makeAudit();
    a.chain.mempool = true;
    await a.fileDocument();
    await a.job.tick();
    const first = a.repo.anchors[0];
    // a fork included it before its limit, but this node only learns of it after giving up
    a.repo.anchors[0].status = 'failed';
    a.pass(6 * MINUTE);
    const ttl = a.chain.slot; // include it while still valid
    a.chain.slot = Math.min(a.chain.slot, first.ttl - 1);
    a.chain.include();
    a.chain.slot = ttl;
    const r = await a.job.tick();
    assert.equal(r.action, 'landed after all');
    assert.equal(a.repo.anchors[0].status, 'onChain');
    assert.deepEqual(
      [a.repo.anchors[0].reason, a.repo.anchors[0].failedAt],
      [null, null],
    );
    assert.equal(a.repo.anchors.length, 1); // no replacement
    await a.runUntil(x => x.action === 'confirmed');
    assert.equal(a.chain.blocks.length, 1);
  });

  it('the given-up one lands late and its replacement is refused: the given-up one is revived, no third anchoring', async () => {
    const a = makeAudit();
    a.chain.mempool = true;
    await a.fileDocument();
    await a.job.tick();
    const x = a.repo.anchors[0];
    a.repo.anchors[0].status = 'failed'; // given up, while a fork still carries it
    a.pass(6 * MINUTE);
    const submit = a.driver.submit.bind(a.driver);
    let first = true;
    a.driver.submit = async cbor => {
      // X lands just before R is sent
      if (first) {
        first = false;
        const slot = a.chain.slot;
        a.chain.slot = x.ttl - 1;
        a.chain.include();
        a.chain.slot = slot;
      }
      return submit(cbor);
    };
    const r = await a.job.tick();
    assert.equal(r.action, 'refused'); // R: its output is spent by X
    assert.equal(a.repo.anchors[1].status, 'failed');
    a.pass(6 * MINUTE);
    const again = await a.job.tick();
    assert.deepEqual([again.action, again.batch], ['landed after all', 1]);
    assert.equal(a.repo.anchors[0].status, 'onChain');
    await a.runUntil(x2 => x2.action === 'confirmed');
    assert.equal(a.repo.anchors.length, 2); // X confirmed, R failed: no third
    assert.equal(a.chain.blocks.length, 1);
    assert.equal((await a.job.tick()).action, 'waiting for the period'); // X counts as the last anchoring
    assert.equal(a.chain.blocks.length, 1);
    // the next hour's news is anchored normally: no false "wallet shared" error, no detour
    await a.fileDocument();
    assert.equal((await a.job.tick()).action, 'waiting for the period');
    a.pass(HOUR);
    const next = await a.job.tick();
    assert.equal(next.action, 'anchored');
    assert.equal(a.repo.anchors.at(-1).prevRoot, x.root);
    assert.ok(!a.errors.some(([, m]) => /spent by something else/.test(m)));
  });

  it('its output spent by something else: concluded only after 10 blocks, then another output is used', async () => {
    const a = makeAudit();
    a.chain.mempool = true;
    await a.fileDocument();
    await a.job.tick();
    const x = a.repo.anchors[0];
    a.repo.anchors[0].status = 'failed';
    a.chain.dropMempool();
    a.chain.ledger = a.chain.ledger.filter(u => u.txHash !== x.inputTxHash); // spent elsewhere (a shared wallet)
    const other = a.chain.topUp('20000000000');
    a.pass(6 * MINUTE);
    assert.equal((await a.job.tick()).action, 'output spent, making sure');
    for (let b = 1; b < 10; b++) {
      a.pass(MINUTE);
      assert.equal((await a.job.tick()).action, 'output spent, making sure');
    }
    a.pass(MINUTE);
    assert.equal((await a.job.tick()).action, 'its output was spent elsewhere');
    const r = await a.job.tick();
    assert.equal(r.action, 'anchored');
    assert.equal(a.repo.anchors[1].inputTxHash, other.txHash);
  });

  it('a crash right after the node took it: after the restart a refusal is not taken for a first one', async () => {
    const repo = createMemoryRepo();
    const driver = fakeDriver();
    driver.chain.mempool = true;
    const before = makeAudit({repo, driver});
    await before.fileDocument();
    // the process dies after the send, before it could record the result
    const update = repo.updateAnchor.bind(repo);
    let calls = 0;
    repo.updateAnchor = async (batch, patch) => {
      if (++calls === 2) throw new Error('process killed');
      return update(batch, patch);
    };
    await assert.rejects(before.job.tick(), /process killed/);
    repo.updateAnchor = update;
    assert.deepEqual(
      [repo.anchors[0].status, repo.anchors[0].attempts],
      ['prepared', 1],
    ); // the send was recorded first
    const after = makeAudit({repo, driver, holder: before.job.holder});
    assert.equal((await after.job.tick()).action, 'refused again, waiting'); // the node has it in its mempool
    assert.equal(repo.anchors[0].status, 'submitted');
    driver.chain.include();
    await after.runUntil(x => x.action === 'confirmed');
    assert.equal(repo.anchors.length, 1);
    assert.equal(driver.chain.blocks.length, 1);
  });

  it('a first send refused outright gives way; the next try waits 5 minutes (no error every minute)', async () => {
    const a = makeAudit();
    await a.fileDocument();
    a.chain.reject = new CardanoError(
      'The chain refused the transaction: ValueNotConservedUTxO',
      'EREJECTED',
    );
    assert.equal((await a.job.tick()).action, 'refused');
    assert.equal(a.repo.anchors[0].status, 'failed');
    assert.equal(a.repo.anchors[0].reason, 'refused');
    a.pass(MINUTE);
    assert.equal((await a.job.tick()).action, 'waiting before anchoring again');
    a.chain.reject = null;
    a.pass(5 * MINUTE);
    assert.equal((await a.job.tick()).action, 'anchored');
    assert.equal(a.repo.anchors[1].batch, 2);
  });

  it('every leaf ends up covered by a confirmed anchoring whose proofs check out', async () => {
    const a = makeAudit();
    for (let hour = 0; hour < 5; hour++) {
      for (let i = 0; i <= hour; i++) await a.fileDocument();
      await a.runUntil(
        x => x.action === 'confirmed' || x.action === 'nothing new',
      );
      a.clock.advance(HOUR);
    }
    assert.ok(a.repo.anchors.every(x => x.status === 'confirmed'));
    assert.equal(a.repo.anchors.length, 5);
    const size = await a.tree.size();
    assert.equal(size, a.repo.anchors.at(-1).size);
    for (let i = 0; i < size; i++) {
      const anchor = await a.job.anchorFor(i);
      assert.ok(anchor, `leaf ${i} is covered`);
      const leaf = a.repo.leaves[i];
      const p = await a.tree.inclusionProof(leaf.key, anchor.size);
      assert.equal(
        verifyInclusion({
          leafHash: p.leaf.hash,
          leafIndex: p.leaf.index,
          size: p.size,
          path: p.path,
          peaks: p.peaks,
          root: anchor.root,
        }),
        true,
      );
    }
    // each anchored root contains the one before it
    for (let k = 1; k < a.repo.anchors.length; k++) {
      const c = await a.tree.consistencyProof(
        a.repo.anchors[k - 1].size,
        a.repo.anchors[k].size,
      );
      assert.equal(
        verifyConsistency({
          ...c,
          oldRoot: a.repo.anchors[k - 1].root,
          newRoot: a.repo.anchors[k].root,
        }),
        true,
      );
    }
    assert.equal(await a.job.anchorFor(size), null);
  });

  it('one instance anchors at a time; the other takes over when its lease runs out', async () => {
    const repo = createMemoryRepo();
    const driver = fakeDriver();
    const one = makeAudit({repo, driver, holder: 'one'});
    const two = makeAudit({repo, driver, holder: 'two'});
    await one.fileDocument();
    assert.equal((await one.job.tick()).action, 'anchored');
    assert.equal((await two.job.tick()).action, 'another instance anchors');
    two.clock.advance(6 * MINUTE);
    assert.notEqual((await two.job.tick()).action, 'another instance anchors');
    assert.equal(driver.chain.submitted.length, 1);
  });

  it('a node still syncing: nothing is anchored, it is tried again', async () => {
    const a = makeAudit({driver: fakeDriver({synced: false})});
    await a.fileDocument();
    assert.deepEqual(await a.job.tick(), {
      action: 'not prepared',
      error: 'EUNAVAILABLE',
    });
    a.chain.synced = true;
    assert.equal((await a.job.tick()).action, 'anchored');
  });

  it('ANCHOR_PERIOD: 1h, 15m, 90s or milliseconds; at least a minute', () => {
    assert.deepEqual(
      ['1h', '15m', '90s', '3600000', undefined].map(v => parsePeriod(v)),
      [3_600_000, 900_000, 90_000, 3_600_000, 3_600_000],
    );
    assert.throws(() => parsePeriod('5s'), /shorter than a minute/);
    assert.throws(() => parsePeriod('hourly'), /not a period/);
  });

  it('after anchoring, a wallet running low is warned about', async () => {
    const a = makeAudit({driver: fakeDriver({lovelace: '5100000'})});
    await a.fileDocument();
    await a.job.tick();
    assert.ok(
      a.published.some(
        p => p.type === 'audit.wallet.low' && p.o.durable === false,
      ),
    );
  });
});

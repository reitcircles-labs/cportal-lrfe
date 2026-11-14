import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {AppError, createEventBus, createLocalSigner} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {
  TITLE_COMMANDS,
  applyTitleCommand,
  modulesFromSettings,
} from '@lrfe/domain-shipping/title';

import {TITLE_STATE_AFTER, verifyTitleProof} from '../verifier/lrfe-verify.mjs';
import {ShippingRecordsService} from '../../shipping-records/src/records.service.js';
import {TitleService} from '../../shipping-records/src/title.service.js';
import {createMemoryRepo as createShippingRepo} from '../../shipping-records/src/repo/memory.js';
import {ACTIVE_ORGANISATIONS} from '../../shipping-records/tests/helpers.js';
import {
  CONTAINER_A,
  blWithCargo,
  splitBody,
  splitByContainer,
  twoContainerBl,
} from '../../shipping-records/tests/split-documents.js';
import {failedChecks} from './helpers.js';
import {publicSource} from './register.js';
import {
  BANK,
  CARRIER,
  SHIPPER,
  TITLE_PROOF_FORMAT,
  staffOf,
  titleAudit,
  titleEvent,
} from './title-proof.js';

/**
 * CB-35, Done when 2: a split child's title proof verifies offline. A child's chain starts from
 * its parent's last entry (the `split`): its first entry's previousHash is that entry's hash, not
 * null. The child's bundle (lrfe-title-proof/1, unchanged for a B/L of its own) carries
 * `parent: {recordId, recordNo, entries}`, the parent's whole chain, and verifyTitleProof checks
 * it: the parent's chain linked, intact, of the parent B/L and signed with the bundle's keys,
 * ending with a `split` entry whose entryHash is the child's first previousHash. Without the
 * parent, or with a parent that is not the one the child was split from, the child does not
 * verify. A child's first entry is `issue-from-split`: the title after it is `with-holder`.
 *
 * The chains are made by the shipping records service as it is (CB-35), recorded on the audit
 * trail and anchored on the fake chain.
 */

const VERIFIER = fileURLToPath(
  new URL('../verifier/lrfe-verify.mjs', import.meta.url),
);

const MINUTE = 60_000;

/**
 * A B/L of the carrier issued to the shipper, endorsed to the bank, surrendered by the bank for
 * amendment and split by the carrier into two children (one per container): the parent's and the
 * children's chains as the shipping records service stores them, with the platform's keys.
 * @param {string} reference the parent's reference; the children's add -A and -B
 * @return {!Promise<{
 *   parent: {recordId: string, recordNo: string, entries: !Array<object>},
 *   children: !Array<{recordId: string, recordNo: string, entries: !Array<object>}>,
 *   jwks: object,
 * }>}
 */
async function splitChains(reference) {
  const repo = createShippingRepo();
  const events = createEventBus({driver: 'memory', source: 'shipping-records'});
  let now = Date.parse('2026-11-14T08:00:00Z');
  const clock = () => {
    now += MINUTE;
    return new Date(now);
  };
  const records = new ShippingRecordsService({
    repo,
    events,
    formats: formatsFromSettings({}),
    clock,
  });
  const titles = new TitleService({
    repo,
    events,
    modules: modulesFromSettings({}),
    clock,
    signer: await createLocalSigner(),
    organisations: ACTIVE_ORGANISATIONS,
  });
  const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
  const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};
  const record = await records.createRecord(
    {
      format: 'dcsa-3.0',
      document: twoContainerBl(reference),
      partyOrganisations: {shipper: SHIPPER},
    },
    drafter,
    CARRIER,
  );
  await records.submit(record.id, 1, drafter, CARRIER);
  await records.commit(record.id, 1, {by: approver}, 'bpm');
  await titles.apply(record.id, {name: 'issue'}, staffOf(CARRIER));
  await titles.apply(
    record.id,
    {name: 'endorse', to: BANK, inBlank: false},
    staffOf(SHIPPER),
  );
  await titles.apply(
    record.id,
    {name: 'surrender-for-amendment'},
    staffOf(BANK),
  );
  const split = await titles.apply(
    record.id,
    {
      name: 'split',
      ...splitBody(splitByContainer(`${reference}-A`, `${reference}-B`)),
    },
    staffOf(CARRIER),
  );
  const children = [];
  for (const child of split.children) {
    children.push({
      recordId: child.recordId,
      recordNo: child.recordNo,
      entries: structuredClone(await repo.listTitleEntries(child.recordId)),
    });
  }
  return {
    parent: {
      recordId: record.id,
      recordNo: reference,
      entries: structuredClone(await repo.listTitleEntries(record.id)),
    },
    children,
    jwks: structuredClone(await titles.keys()),
  };
}

/**
 * A child's title proof bundle: its entries, the keys, the anchor and its parent's chain.
 * @param {object} child
 * @param {object} anchor the audit's trail-entry proof, or {pending: true}
 * @param {object} jwks
 * @param {?object} parent `{recordId, recordNo, entries}`, or null for none
 * @return {object}
 */
function childBundle(child, anchor, jwks, parent) {
  const bundle = {
    format: TITLE_PROOF_FORMAT,
    recordId: child.recordId,
    recordNo: child.recordNo,
    entries: child.entries,
    jwks,
    anchor,
  };
  if (parent !== null) {
    bundle.parent = parent;
  }
  return structuredClone(bundle);
}

/**
 * The command line on a bundle (JSON file), without a network: only for results reached before
 * the blockchain (a pending anchor).
 * @param {object} bundle
 * @param {!Array<string>} [args]
 * @return {object} spawnSync's answer
 */
function cli(bundle, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'lrfe-title-split-'));
  try {
    writeFileSync(join(dir, 'title-proof.json'), JSON.stringify(bundle));
    return spawnSync(
      process.execPath,
      [VERIFIER, join(dir, 'title-proof.json'), ...args],
      {encoding: 'utf8'},
    );
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

describe("a split child's title proof verifies offline (CB-35)", () => {
  let chains;
  let other;
  let audit;
  let offline;
  /** The trail entry of each chain entry's event, by `<recordId>:<seq>`. */
  const trailEntries = new Map();

  /**
   * The audit's trail-entry proof of a chain entry's event, as JSON carries it.
   * @param {string} recordId
   * @param {number} seq
   * @return {!Promise<object>}
   */
  const proofOf = async (recordId, seq) =>
    JSON.parse(
      JSON.stringify(
        await audit.proofs.proof(
          'trail-entry',
          String(trailEntries.get(`${recordId}:${seq}`).seq),
        ),
      ),
    );

  before(async () => {
    chains = await splitChains('CB35-PARENT');
    other = await splitChains('CB35-OTHER');
    audit = await titleAudit();
    for (const chain of [chains.parent, ...chains.children]) {
      for (const entry of chain.entries) {
        const event = titleEvent(entry, {
          recordNo: chain.recordNo,
          actor: {
            id: entry.actor.id,
            name: entry.actor.name,
            org: entry.actor.org,
          },
        });
        trailEntries.set(
          `${chain.recordId}:${entry.seq}`,
          await audit.consume(event),
        );
      }
    }
    await audit.anchor();
    const wallet = await audit.cardano.address();
    offline = {fetchImpl: publicSource(audit.driver), address: wallet};
  });
  after(async () => {
    await audit?.close();
  });

  it("starts each child's chain from the parent's split entry", () => {
    const split = chains.parent.entries.at(-1);
    assert.equal(split.command, 'split');
    for (const child of chains.children) {
      assert.equal(child.entries.length, 1);
      assert.equal(child.entries[0].command, 'issue-from-split');
      assert.equal(child.entries[0].previousHash, split.entryHash);
    }
  });

  it("verifies a child's bundle carrying its parent's chain: chain, signatures, the anchored entry", async () => {
    for (const child of chains.children) {
      const bundle = childBundle(
        child,
        await proofOf(child.recordId, 1),
        chains.jwks,
        chains.parent,
      );
      const result = await verifyTitleProof(bundle, offline);
      assert.equal(result.valid, true, JSON.stringify(result.checks));
      assert.deepEqual(failedChecks(result), []);
      assert.equal(result.title.seq, 1);
      assert.equal(result.title.holder, BANK);
      assert.equal(result.title.state, 'with-holder');
    }
  });

  it("does not verify a child's bundle without its parent", async () => {
    const child = chains.children[0];
    const bundle = childBundle(
      child,
      await proofOf(child.recordId, 1),
      chains.jwks,
      null,
    );
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
    assert.ok(failedChecks(result).includes('chain of title'));
  });

  it('does not verify with the parent of another split', async () => {
    const child = chains.children[0];
    const bundle = childBundle(
      child,
      await proofOf(child.recordId, 1),
      chains.jwks,
      other.parent,
    );
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
  });

  it("does not verify when the parent's split entry is changed", async () => {
    const child = chains.children[0];
    const parent = structuredClone(chains.parent);
    parent.entries.at(-1).to = SHIPPER;
    const bundle = childBundle(
      child,
      await proofOf(child.recordId, 1),
      chains.jwks,
      parent,
    );
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
  });

  it("does not verify when the parent's chain stops before the split", async () => {
    const child = chains.children[0];
    const parent = structuredClone(chains.parent);
    parent.entries = parent.entries.slice(0, -1);
    const bundle = childBundle(
      child,
      await proofOf(child.recordId, 1),
      chains.jwks,
      parent,
    );
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
  });

  it("does not verify when an entry of the parent's chain is removed", async () => {
    const child = chains.children[0];
    const parent = structuredClone(chains.parent);
    parent.entries = parent.entries.filter(e => e.command !== 'endorse');
    const bundle = childBundle(
      child,
      await proofOf(child.recordId, 1),
      chains.jwks,
      parent,
    );
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
  });

  it("does not verify when the parent's chain is given as another B/L's (its recordId changed)", async () => {
    const child = chains.children[0];
    const parent = {
      ...structuredClone(chains.parent),
      recordId: child.recordId,
    };
    const bundle = childBundle(
      child,
      await proofOf(child.recordId, 1),
      chains.jwks,
      parent,
    );
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
  });

  it('does not verify a child whose first entry was made to look like a B/L of its own (previousHash null)', async () => {
    const child = structuredClone(chains.children[0]);
    child.entries[0].previousHash = null;
    const bundle = childBundle(
      child,
      await proofOf(child.recordId, 1),
      chains.jwks,
      null,
    );
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
  });

  it("verifies the parent's own bundle, without a parent: the title is split, no holder", async () => {
    const parent = chains.parent;
    const bundle = structuredClone({
      format: TITLE_PROOF_FORMAT,
      recordId: parent.recordId,
      recordNo: parent.recordNo,
      entries: parent.entries,
      jwks: chains.jwks,
      anchor: await proofOf(parent.recordId, parent.entries.length),
    });
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, true, JSON.stringify(result.checks));
    assert.equal(result.title.state, 'split');
    assert.equal(result.title.holder, null);
  });

  it("checks a child's bundle on the command line too: before anchoring only 'anchored' fails (exit 1)", () => {
    const run = cli(
      childBundle(
        chains.children[1],
        {pending: true},
        chains.jwks,
        chains.parent,
      ),
      ['--json'],
    );
    assert.equal(run.status, 1, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(failedChecks(result), ['anchored']);
    assert.equal(result.title.state, 'with-holder');
  });

  // (added: the brief, the verifier's own table of states must cover issue-from-split and agree
  // with the engine's) the verifier is a single file with no imports of the platform, so it keeps
  // its own copy of the states; this compares it with the title engine's table.
  it("names the state after each entry's command as the title engine does, issue-from-split included (added: brief)", () => {
    for (const [name, rule] of Object.entries(TITLE_COMMANDS)) {
      assert.equal(TITLE_STATE_AFTER.get(name), rule.to, name);
    }
    const parent = {
      kind: 'negotiable',
      state: 'amendment-requested',
      carrier: CARRIER,
      holder: CARRIER,
      endorsement: 'named',
      consignee: null,
      returnTo: BANK,
    };
    const split = applyTitleCommand(
      parent,
      {name: 'split', children: 2},
      {organisation: CARRIER},
    );
    assert.equal(
      TITLE_STATE_AFTER.get('issue-from-split'),
      split.children[0].state,
    );
    assert.deepEqual(
      [...TITLE_STATE_AFTER.keys()].sort(),
      [...Object.keys(TITLE_COMMANDS), 'issue-from-split'].sort(),
    );
  });
});

/**
 * (added: coordinator follow-up) A split of a split: the bank surrenders a child for amendment and
 * the carrier splits it again (CONTAINER_A's cargo divided). The grandchild's title proof, as the
 * shipping records service gives it, nests the grandparent's chain in `parent.parent`, and
 * verifies offline; a grandparent chain tampered with does not.
 * @param {string} reference the first B/L's reference
 * @return {!Promise<{bundle: object, grandchild: object}>} the grandchild's bundle (anchor
 *     pending) and the grandchild `{recordId, recordNo, entries}`
 */
async function splitOfSplit(reference) {
  const repo = createShippingRepo();
  const events = createEventBus({driver: 'memory', source: 'shipping-records'});
  let now = Date.parse('2026-11-14T09:00:00Z');
  const clock = () => {
    now += MINUTE;
    return new Date(now);
  };
  const records = new ShippingRecordsService({
    repo,
    events,
    formats: formatsFromSettings({}),
    clock,
  });
  const titles = new TitleService({
    repo,
    events,
    modules: modulesFromSettings({}),
    clock,
    signer: await createLocalSigner(),
    organisations: ACTIVE_ORGANISATIONS,
    audit: {
      /**
       * Nothing is anchored in the service's view: the test anchors the entry itself.
       * @return {!Promise<object>}
       */
      async entryProof() {
        throw new AppError(404, 'There is no trail entry for this event');
      },
    },
  });
  const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
  const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};
  const record = await records.createRecord(
    {
      format: 'dcsa-3.0',
      document: twoContainerBl(reference),
      partyOrganisations: {shipper: SHIPPER},
    },
    drafter,
    CARRIER,
  );
  await records.submit(record.id, 1, drafter, CARRIER);
  await records.commit(record.id, 1, {by: approver}, 'bpm');
  await titles.apply(record.id, {name: 'issue'}, staffOf(CARRIER));
  await titles.apply(
    record.id,
    {name: 'endorse', to: BANK, inBlank: false},
    staffOf(SHIPPER),
  );
  await titles.apply(
    record.id,
    {name: 'surrender-for-amendment'},
    staffOf(BANK),
  );
  const first = await titles.apply(
    record.id,
    {
      name: 'split',
      ...splitBody(splitByContainer(`${reference}-A`, `${reference}-B`)),
    },
    staffOf(CARRIER),
  );
  const child = first.children[0];
  await titles.apply(
    child.recordId,
    {name: 'surrender-for-amendment'},
    staffOf(BANK),
  );
  const second = await titles.apply(
    child.recordId,
    {
      name: 'split',
      ...splitBody([
        blWithCargo(`${reference}-A1`, {
          cargo: [{container: CONTAINER_A, packages: 250, weight: 7500}],
        }),
        blWithCargo(`${reference}-A2`, {
          cargo: [{container: CONTAINER_A, packages: 150, weight: 4500}],
        }),
      ]),
    },
    staffOf(CARRIER),
  );
  const grandchild = second.children[0];
  const bundle = structuredClone(
    await titles.proof(grandchild.recordId, staffOf(BANK)),
  );
  return {
    bundle,
    parentId: child.recordId,
    grandparentId: record.id,
    grandchild: {
      recordId: grandchild.recordId,
      recordNo: grandchild.recordNo,
      entries: bundle.entries,
    },
  };
}

describe("a split of a split: the grandchild's title proof nests its grandparent and verifies offline (CB-35, added: follow-up)", () => {
  let made;
  let audit;
  let offline;
  let anchor;

  before(async () => {
    made = await splitOfSplit('CB35-GRAND');
    audit = await titleAudit();
    const [entry] = made.grandchild.entries;
    const trailEntry = await audit.consume(
      titleEvent(entry, {
        recordNo: made.grandchild.recordNo,
        actor: {
          id: entry.actor.id,
          name: entry.actor.name,
          org: entry.actor.org,
        },
      }),
    );
    await audit.anchor();
    offline = {
      fetchImpl: publicSource(audit.driver),
      address: await audit.cardano.address(),
    };
    anchor = JSON.parse(
      JSON.stringify(
        await audit.proofs.proof('trail-entry', String(trailEntry.seq)),
      ),
    );
  });
  after(async () => {
    await audit?.close();
  });

  it('nests the chains: the parent split from the grandparent, each ending with its split', () => {
    const {bundle} = made;
    assert.equal(bundle.parent.recordId, made.parentId);
    assert.equal(bundle.parent.parent.recordId, made.grandparentId);
    assert.equal(bundle.parent.entries[0].command, 'issue-from-split');
    assert.equal(bundle.parent.entries.at(-1).command, 'split');
    assert.equal(bundle.parent.parent.entries.at(-1).command, 'split');
    assert.equal(bundle.parent.parent.parent, undefined);
  });

  it("verifies the grandchild's bundle offline: every check passes once anchored", async () => {
    const bundle = {...structuredClone(made.bundle), anchor};
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, true, JSON.stringify(result.checks));
    assert.deepEqual(failedChecks(result), []);
    assert.equal(result.title.state, 'with-holder');
    assert.equal(result.title.holder, BANK);
  });

  it("does not verify when the grandparent's chain is tampered with", async () => {
    const bundle = {...structuredClone(made.bundle), anchor};
    bundle.parent.parent.entries[1].to = SHIPPER;
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
    assert.ok(failedChecks(result).includes('split from'));
  });

  it('does not verify when the grandparent is left out', async () => {
    const bundle = {...structuredClone(made.bundle), anchor};
    delete bundle.parent.parent;
    const result = await verifyTitleProof(bundle, offline);
    assert.equal(result.valid, false);
    assert.ok(failedChecks(result).includes('split from'));
  });
});

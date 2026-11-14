import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {verifyTitleProof} from '../verifier/lrfe-verify.mjs';
import {failedChecks} from './helpers.js';
import {publicSource} from './register.js';
import {
  BANK,
  BUYER,
  CARRIER,
  SHIPPER,
  auditedChain,
  bundleOf,
} from './title-proof.js';

/**
 * CB-37, Done when 2: the chain of title of a mixed journey (issue → blank endorsement to bank A
 * → transfer to bank B → named endorsement to the buyer → surrender → release), made by the
 * shipping records service as it is, each entry signed (CB-32), published, recorded on the audit
 * trail and anchored (CB-33): its title proof bundle verifies offline with verifyTitleProof and
 * the command line of lrfe-verify.mjs.
 */

const VERIFIER = fileURLToPath(
  new URL('../verifier/lrfe-verify.mjs', import.meta.url),
);

/** Bank B: the second bank, holder by transfer. */
const BANK_B = 'org-bank-b';

/** The mixed journey: each step's organisation and command. */
const MIXED_JOURNEY = Object.freeze([
  [CARRIER, {name: 'issue'}],
  [SHIPPER, {name: 'endorse', to: BANK, inBlank: true}],
  [BANK, {name: 'transfer', to: BANK_B}],
  [BANK_B, {name: 'endorse', to: BUYER, inBlank: false}],
  [BUYER, {name: 'surrender'}],
  [CARRIER, {name: 'release'}],
]);

/**
 * The command line on a bundle (JSON file), without a network: only for results reached before
 * the blockchain (a pending anchor).
 * @param {object} bundle
 * @param {!Array<string>} [args]
 * @return {object} spawnSync's answer
 */
function cli(bundle, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'lrfe-title-'));
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

describe('the title proof of a mixed journey verifies offline (CB-37)', () => {
  let chain;
  let offline;
  before(async () => {
    chain = await auditedChain({
      reference: 'CB37-MIXED',
      journey: MIXED_JOURNEY,
    });
    const wallet = await chain.audit.cardano.address();
    offline = {fetchImpl: publicSource(chain.audit.driver), address: wallet};
  });
  after(async () => {
    await chain.audit.close();
  });

  it('has six entries: issue, endorse in blank, transfer, endorse to a name, surrender, release', () => {
    assert.deepEqual(
      chain.entries.map(entry => [
        entry.command,
        entry.from,
        entry.to,
        entry.endorsement,
      ]),
      [
        ['issue', null, SHIPPER, 'none'],
        ['endorse', SHIPPER, BANK, 'blank'],
        ['transfer', BANK, BANK_B, 'blank'],
        ['endorse', BANK_B, BUYER, 'named'],
        ['surrender', BUYER, CARRIER, 'named'],
        ['release', CARRIER, null, 'named'],
      ],
    );
  });

  it('verifies offline: chain, every signature, the last entry anchored on the blockchain', async () => {
    const anchor = await chain.proofOfEntry(chain.entries.length);
    const result = await verifyTitleProof(bundleOf(chain, anchor), offline);
    assert.equal(result.valid, true, JSON.stringify(result.checks));
    assert.deepEqual(failedChecks(result), []);
    assert.equal(result.title.seq, 6);
    assert.equal(result.title.holder, null);
    assert.equal(result.title.state, 'accomplished');
  });

  it('verifies a proof of the transfer, naming bank B as the holder then', async () => {
    const older = bundleOf(chain, await chain.proofOfEntry(3), {
      entries: chain.entries.slice(0, 3),
    });
    const result = await verifyTitleProof(older, offline);
    assert.equal(result.valid, true, JSON.stringify(result.checks));
    assert.equal(result.title.holder, BANK_B);
    assert.equal(result.title.state, 'with-holder');
  });

  it('fails when the transfer is replaced by the blank endorsee endorsing on (a changed entry)', async () => {
    const anchor = await chain.proofOfEntry(chain.entries.length);
    const entries = structuredClone(chain.entries);
    entries[2].command = 'endorse';
    const result = await verifyTitleProof(
      bundleOf(chain, anchor, {entries}),
      offline,
    );
    assert.equal(result.valid, false);
  });

  it('fails when the transfer is removed from the chain', async () => {
    const anchor = await chain.proofOfEntry(chain.entries.length);
    const entries = chain.entries.filter(entry => entry.command !== 'transfer');
    const result = await verifyTitleProof(
      bundleOf(chain, anchor, {entries}),
      offline,
    );
    assert.equal(result.valid, false);
  });

  it('checks on the command line too: the chain of a pending bundle verifies, not anchored yet (exit 1)', () => {
    const run = cli(bundleOf(chain, {pending: true}), ['--json']);
    assert.equal(run.status, 1, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(failedChecks(result), ['anchored']);
    assert.equal(result.title.state, 'accomplished');
  });
});

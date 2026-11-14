import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {canonicalJson, createLocalSigner, signJws} from '@lrfe/common';

import {entryHashOf} from '../../shipping-records/src/chain.js';
import {verifyProof, verifyTitleProof} from '../verifier/lrfe-verify.mjs';
import {audited, publicSource} from './register.js';
import {BANK, BUYER, auditedChain, bundleOf} from './title-proof.js';

/**
 * CB-33: the offline verifier and the title proof bundle (lrfe-title-proof/1): the chain's links
 * and every signature against the bundle's keys (optionally pinned with --title-key), the last
 * entry equal to the entry inside the anchor's trail-entry proof, and that proof checked as today.
 * The existing formats verify unchanged.
 */

const VERIFIER = fileURLToPath(
  new URL('../verifier/lrfe-verify.mjs', import.meta.url),
);
const clone = x => structuredClone(x);
const failed = r => r.checks.filter(c => !c.ok).map(c => c.name);

/**
 * The fingerprint a --title-key pins: SHA-256 of the canonical JSON of the platform's key set, hex.
 * @param {{keys: !Array<object>}} jwks
 * @return {string}
 */
const fingerprintOf = jwks =>
  createHash('sha256').update(canonicalJson(jwks)).digest('hex');

/**
 * An entry with new content, hashed again and signed with `signer` (a forger's key).
 * @param {object} entry
 * @param {object} change
 * @param {object} signer
 * @return {!Promise<object>}
 */
async function resigned(entry, change, signer) {
  const content = {...entry, ...change, kid: await signer.currentKid()};
  delete content.entryHash;
  delete content.signature;
  const signature = await signJws(content, signer, {
    typ: 'lrfe-title-entry',
    kid: content.kid,
  });
  return {...content, entryHash: entryHashOf(content), signature};
}

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

describe('the offline verifier and the title proof (lrfe-title-proof/1, CB-33)', () => {
  let c;
  let anchor;
  let wallet;
  let offline;
  before(async () => {
    c = await auditedChain();
    anchor = await c.proofOfEntry(c.entries.length);
    wallet = await c.audit.cardano.address();
    offline = {fetchImpl: publicSource(c.audit.driver), address: wallet};
  });
  after(async () => {
    await c.audit.close();
  });

  describe('a genuine bundle', () => {
    it('verifies offline: chain, signatures, the last entry anchored on the blockchain', async () => {
      const r = await verifyTitleProof(bundleOf(c, anchor), offline);
      assert.equal(r.valid, true, JSON.stringify(r.checks));
      assert.deepEqual(failed(r), []);
    });

    it('names the current holder and the state after the last entry', async () => {
      const r = await verifyTitleProof(bundleOf(c, anchor), offline);
      assert.equal(r.title.recordId, c.recordId);
      assert.equal(r.title.recordNo, c.recordNo);
      assert.equal(r.title.seq, c.entries.length);
      assert.equal(r.title.holder, BUYER);
      assert.equal(r.title.holder, c.title.holder);
      assert.equal(r.title.state, c.title.state);
    });

    it('verifies with the platform key pinned (--title-key), in any case and with colons', async () => {
      const fp = fingerprintOf(c.jwks);
      for (const titleKey of [
        fp,
        fp.toUpperCase(),
        fp.match(/../g).join(':'),
      ]) {
        const r = await verifyTitleProof(bundleOf(c, anchor), {
          ...offline,
          titleKey,
        });
        assert.equal(r.valid, true, `${titleKey}: ${JSON.stringify(r.checks)}`);
      }
    });

    it('verifies a proof of an older entry, naming the holder of then (seq 2: the bank)', async () => {
      const older = bundleOf(c, await c.proofOfEntry(2), {
        entries: c.entries.slice(0, 2),
      });
      const r = await verifyTitleProof(older, offline);
      assert.equal(r.valid, true, JSON.stringify(r.checks));
      assert.equal(r.title.seq, 2);
      assert.equal(r.title.holder, BANK);
    });
  });

  describe('a pending anchor', () => {
    it('verifies the chain but says it is not anchored (not valid yet), naming the holder', async () => {
      const r = await verifyTitleProof(bundleOf(c, {pending: true}), offline);
      assert.equal(r.valid, false);
      assert.deepEqual(failed(r), ['anchored']);
      assert.equal(r.title.holder, BUYER);
    });

    it('still finds a tampered chain while the anchor is pending', async () => {
      const entries = clone(c.entries);
      entries[1].to = BUYER;
      const r = await verifyTitleProof(
        bundleOf(c, {pending: true}, {entries}),
        offline,
      );
      assert.equal(r.valid, false);
      assert.ok(failed(r).length > 1, JSON.stringify(r.checks));
    });
  });

  /**
   * Checks a tampered bundle, once the genuine bundle is known to verify (so that a verifier
   * refusing everything does not pass these tests).
   * @param {object} bundle
   * @param {object} [options]
   * @return {!Promise<object>} the result of the tampered bundle
   */
  async function tampered(bundle, options) {
    const genuine = await verifyTitleProof(bundleOf(c, anchor), offline);
    assert.equal(genuine.valid, true, JSON.stringify(genuine.checks));
    return verifyTitleProof(bundle, options);
  }

  describe('tampering', () => {
    it('fails a changed entry', async () => {
      const entries = clone(c.entries);
      entries[1].to = 'org-thief';
      const r = await tampered(bundleOf(c, anchor, {entries}), offline);
      assert.equal(r.valid, false);
    });

    it('fails a changed entry hashed again (its signature no longer matches)', async () => {
      const entries = clone(c.entries);
      const content = {...entries[1], to: 'org-thief'};
      delete content.entryHash;
      delete content.signature;
      entries[1] = {
        ...entries[1],
        to: 'org-thief',
        entryHash: entryHashOf(content),
      };
      const r = await tampered(bundleOf(c, anchor, {entries}), offline);
      assert.equal(r.valid, false);
    });

    it('fails a changed last entry, even one equal to a changed anchor proof', async () => {
      const entries = clone(c.entries);
      entries.at(-1).to = 'org-thief';
      const forged = clone(anchor);
      forged.trail.entry.data.entry.to = 'org-thief';
      const r = await tampered(bundleOf(c, forged, {entries}), offline);
      assert.equal(r.valid, false);
    });

    it('fails a bundle whose last entry was removed (the last entry is not the anchored one)', async () => {
      const r = await tampered(
        bundleOf(c, anchor, {entries: c.entries.slice(0, -1)}),
        offline,
      );
      assert.equal(r.valid, false);
    });

    it('fails a bundle with an entry removed in the middle, or the entries reordered', async () => {
      const middle = [c.entries[0], c.entries[2]];
      const reordered = [c.entries[1], c.entries[0], c.entries[2]];
      for (const entries of [middle, reordered]) {
        const r = await tampered(bundleOf(c, anchor, {entries}), offline);
        assert.equal(r.valid, false);
      }
    });

    it('fails a bundle with no entries', async () => {
      const r = await tampered(bundleOf(c, anchor, {entries: []}), offline);
      assert.equal(r.valid, false);
    });

    it('fails a signature against other keys (a key set that is not the platform’s)', async () => {
      const other = await createLocalSigner();
      const bundle = bundleOf(c, anchor);
      bundle.jwks = await other.jwks();
      const r = await tampered(bundle, offline);
      assert.equal(r.valid, false);
    });

    it("fails a chain re-signed with a forger's key and keys, whatever the pinned key", async () => {
      const forger = await createLocalSigner();
      const entries = [];
      for (const entry of c.entries) {
        entries.push(
          await resigned(
            entry,
            {previousHash: entries.at(-1)?.entryHash ?? null},
            forger,
          ),
        );
      }
      const bundle = bundleOf(c, anchor, {entries});
      bundle.jwks = await forger.jwks();
      // the chain is the forger's own, but its last entry is not the anchored one
      assert.equal((await tampered(bundle, offline)).valid, false);
      // pinned to the platform's key, the forger's keys are refused too
      const pinned = await tampered(bundle, {
        ...offline,
        titleKey: fingerprintOf(c.jwks),
      });
      assert.equal(pinned.valid, false);
    });

    it('fails a genuine bundle checked against another key fingerprint (--title-key)', async () => {
      const r = await tampered(bundleOf(c, anchor), {
        ...offline,
        titleKey: 'ab'.repeat(32),
      });
      assert.equal(r.valid, false);
    });

    it('fails an anchor that is the proof of another event: an older entry of the B/L', async () => {
      const r = await tampered(bundleOf(c, await c.proofOfEntry(1)), offline);
      assert.equal(r.valid, false);
    });

    it('fails an anchor that is the proof of another B/L’s entry', async () => {
      const other = await auditedChain({reference: 'CB33-OTHER'});
      try {
        const r = await tampered(
          bundleOf(c, await other.proofOfEntry(other.entries.length)),
          {fetchImpl: publicSource(other.audit.driver)},
        );
        assert.equal(r.valid, false);
      } finally {
        await other.audit.close();
      }
    });

    it('fails an anchor proof that does not check as today (its trail entry rewritten)', async () => {
      const forged = clone(anchor);
      forged.trail.entry.time = '2030-01-01T00:00:00.000Z';
      const r = await tampered(bundleOf(c, forged), offline);
      assert.equal(r.valid, false);
    });

    it('fails an anchor paid by another wallet than the given address (--address), as today', async () => {
      const r = await tampered(bundleOf(c, anchor), {
        ...offline,
        address: 'addr_test1qqnotthewallet',
      });
      assert.equal(r.valid, false);
    });

    it('refuses what is not a title proof bundle', async () => {
      for (const bundle of [
        null,
        {},
        {...bundleOf(c, anchor), format: 'lrfe-title-proof/2'},
      ]) {
        const r = await tampered(bundle, offline);
        assert.equal(r.valid, false);
      }
    });
  });

  describe('the command line', () => {
    it('reads a title proof bundle: a pending anchor checks the chain and says not anchored (exit 1)', () => {
      const run = cli(bundleOf(c, {pending: true}));
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stdout, /not anchored/i);
      assert.doesNotMatch(run.stdout, /not an audit proof/);
    });

    it('gives the holder and the checks as JSON (--json)', () => {
      const run = cli(bundleOf(c, {pending: true}), ['--json']);
      const result = JSON.parse(run.stdout);
      assert.equal(result.valid, false);
      assert.equal(result.title.holder, BUYER);
      assert.deepEqual(failed(result), ['anchored']);
    });

    it('takes --title-key: another fingerprint fails (exit 1)', () => {
      const run = cli(bundleOf(c, {pending: true}), [
        '--title-key',
        'ab'.repeat(32),
        '--json',
      ]);
      assert.equal(run.status, 1);
      const result = JSON.parse(run.stdout);
      assert.ok(failed(result).length > 1, run.stdout);
    });

    it('names --title-key in its usage', () => {
      const run = spawnSync(process.execPath, [VERIFIER, '--help'], {
        encoding: 'utf8',
      });
      assert.match(run.stdout, /--title-key/);
    });
  });

  describe('the existing formats, unchanged', () => {
    it('verifies a B/L entry’s trail-entry proof (lrfe-audit-proof/1) as before', async () => {
      const r = await verifyProof(clone(anchor), offline);
      assert.equal(r.valid, true, JSON.stringify(r.checks));
      assert.equal(anchor.format, 'lrfe-audit-proof/1');
      assert.deepEqual(Object.keys(anchor), [
        'format',
        'status',
        'item',
        'trail',
        'leaf',
        'tree',
        'anchor',
      ]);
    });

    it('does not take a title bundle for an audit proof, nor an audit proof for a title bundle', async () => {
      assert.equal(
        (await verifyProof(bundleOf(c, anchor), offline)).valid,
        false,
      );
      assert.equal(
        (await verifyTitleProof(clone(anchor), offline)).valid,
        false,
      );
    });

    it("verifies an old land record's proofs unchanged: record version and trail entry", async () => {
      const a = await audited();
      await a.anchor();
      const land = {fetchImpl: publicSource(a.driver)};
      const version = JSON.parse(
        JSON.stringify(await a.proofs.proof('record-version', a.record.id, 1)),
      );
      assert.equal(version.format, 'lrfe-audit-proof/1');
      assert.deepEqual(Object.keys(version), [
        'format',
        'status',
        'item',
        'leaf',
        'tree',
        'anchor',
      ]);
      assert.equal((await verifyProof(version, land)).valid, true);
      const entry = JSON.parse(
        JSON.stringify(await a.proofs.proof('trail-entry', '1')),
      );
      assert.equal((await verifyProof(entry, land)).valid, true);
    });

    it('answers a land proof made before its anchoring on the command line as before (exit 1, not anchored yet)', async () => {
      const a = await audited();
      const waiting = JSON.parse(
        JSON.stringify(await a.proofs.proof('record-version', a.record.id, 1)),
      );
      const run = cli(waiting);
      assert.equal(run.status, 1);
      assert.match(run.stdout, /FAIL {2}anchored: not anchored yet/);
    });
  });
});

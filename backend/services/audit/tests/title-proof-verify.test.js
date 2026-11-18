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
import {failedChecks} from './helpers.js';
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
      assert.deepEqual(failedChecks(r), []);
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
      assert.deepEqual(failedChecks(r), ['anchored']);
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
      assert.ok(failedChecks(r).length > 1, JSON.stringify(r.checks));
    });
  });

  describe('tampering', () => {
    before(async () => {
      const genuine = await verifyTitleProof(bundleOf(c, anchor), offline);
      assert.equal(genuine.valid, true, JSON.stringify(genuine.checks));
    });

    it('fails changed, rehashed, removed, reordered or empty entries, even with a matching forged anchor proof', async () => {
      const changed = clone(c.entries);
      changed[1].to = 'org-thief';
      assert.equal(
        (
          await verifyTitleProof(
            bundleOf(c, anchor, {entries: changed}),
            offline,
          )
        ).valid,
        false,
      );

      const rehashed = clone(c.entries);
      const content = {...rehashed[1], to: 'org-thief'};
      delete content.entryHash;
      delete content.signature;
      rehashed[1] = {
        ...rehashed[1],
        to: 'org-thief',
        entryHash: entryHashOf(content),
      };
      assert.equal(
        (
          await verifyTitleProof(
            bundleOf(c, anchor, {entries: rehashed}),
            offline,
          )
        ).valid,
        false,
      );

      const forgedEntries = clone(c.entries);
      forgedEntries.at(-1).to = 'org-thief';
      const forgedAnchor = clone(anchor);
      forgedAnchor.trail.entry.data.entry.to = 'org-thief';
      assert.equal(
        (
          await verifyTitleProof(
            bundleOf(c, forgedAnchor, {entries: forgedEntries}),
            offline,
          )
        ).valid,
        false,
      );

      for (const entries of [
        c.entries.slice(0, -1),
        [c.entries[0], c.entries[2]],
        [c.entries[1], c.entries[0], c.entries[2]],
        [],
      ]) {
        assert.equal(
          (await verifyTitleProof(bundleOf(c, anchor, {entries}), offline))
            .valid,
          false,
        );
      }
    });

    it('fails wrong keys, forged chains, or a wrong --title-key fingerprint', async () => {
      const other = await createLocalSigner();
      const wrongKeys = bundleOf(c, anchor);
      wrongKeys.jwks = await other.jwks();
      assert.equal((await verifyTitleProof(wrongKeys, offline)).valid, false);

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
      const forgedChain = bundleOf(c, anchor, {entries});
      forgedChain.jwks = await forger.jwks();
      assert.equal((await verifyTitleProof(forgedChain, offline)).valid, false);
      assert.equal(
        (
          await verifyTitleProof(forgedChain, {
            ...offline,
            titleKey: fingerprintOf(c.jwks),
          })
        ).valid,
        false,
      );

      assert.equal(
        (
          await verifyTitleProof(bundleOf(c, anchor), {
            ...offline,
            titleKey: 'ab'.repeat(32),
          })
        ).valid,
        false,
      );
    });

    it('fails anchors for another entry/B/L, rewritten trail proofs, or another paying wallet', async () => {
      assert.equal(
        (await verifyTitleProof(bundleOf(c, await c.proofOfEntry(1)), offline))
          .valid,
        false,
      );

      const other = await auditedChain({reference: 'CB33-OTHER'});
      try {
        assert.equal(
          (
            await verifyTitleProof(
              bundleOf(c, await other.proofOfEntry(other.entries.length)),
              {fetchImpl: publicSource(other.audit.driver)},
            )
          ).valid,
          false,
        );
      } finally {
        await other.audit.close();
      }

      const forged = clone(anchor);
      forged.trail.entry.time = '2030-01-01T00:00:00.000Z';
      assert.equal(
        (await verifyTitleProof(bundleOf(c, forged), offline)).valid,
        false,
      );

      assert.equal(
        (
          await verifyTitleProof(bundleOf(c, anchor), {
            ...offline,
            address: 'addr_test1qqnotthewallet',
          })
        ).valid,
        false,
      );
    });

    it('refuses what is not a title proof bundle', async () => {
      for (const bundle of [
        null,
        {},
        {...bundleOf(c, anchor), format: 'lrfe-title-proof/2'},
      ]) {
        assert.equal((await verifyTitleProof(bundle, offline)).valid, false);
      }
    });
  });

  describe('the command line', () => {
    it('reads a title proof bundle: pending anchor (exit 1), --json, and rejects a wrong --title-key', () => {
      const text = cli(bundleOf(c, {pending: true}));
      assert.equal(text.status, 1, text.stderr);
      assert.match(text.stdout, /not anchored/i);
      assert.doesNotMatch(text.stdout, /not an audit proof/);

      const json = cli(bundleOf(c, {pending: true}), ['--json']);
      const result = JSON.parse(json.stdout);
      assert.equal(result.valid, false);
      assert.equal(result.title.holder, BUYER);
      assert.deepEqual(failedChecks(result), ['anchored']);

      const badKey = cli(bundleOf(c, {pending: true}), [
        '--title-key',
        'ab'.repeat(32),
        '--json',
      ]);
      assert.equal(badKey.status, 1);
      assert.ok(
        failedChecks(JSON.parse(badKey.stdout)).length > 1,
        badKey.stdout,
      );
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
      // a shipping install's anchoring names its product (CB-49)
      const r = await verifyProof(clone(anchor), {
        ...offline,
        product: 'shipping',
      });
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

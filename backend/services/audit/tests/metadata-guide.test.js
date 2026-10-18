// The user guide "What is on the blockchain" (angular-app/docs/user-guide/what-is-on-the-blockchain.md,
// API-728) shows a worked example of how an anchoring's root is computed, and a script to recompute
// it. These tests recompute the example with the service's own code and run the guide's script, so
// the guide cannot drift from the implementation.
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson} from '@lrfe/common';
import {sealOf} from '../../edrms/src/seal.js';
import {anchorMetadata} from '../src/cardano/tx.js';
import {
  inclusionPositions,
  LEAF_TYPES,
  leafHash,
  nodeHash,
  peaks,
  rootOf,
  verifyInclusion,
} from '../src/mmr.js';

const GUIDE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../angular-app/docs/user-guide/what-is-on-the-blockchain.md',
);
const guide = readFileSync(GUIDE, 'utf8');
const sha256 = s => createHash('sha256').update(s).digest('hex');
const hex = b => b.toString('hex');

// the guide's example: one document version in full, four stand-in seals
const FILE = 'This text stands in for the bytes of a scanned PDF.';
const DOCUMENT_ID = '00000000-0000-4000-8000-000000000001';
const EDRMS_NO = 'EDR-NA-2026-000001';
const VERSION = {
  versionNumber: 1,
  sha256: sha256(FILE),
  fields: [{k: 'deedNo', label: 'Deed number', v: 'T 2210/2008'}],
  recordMetadata: {title: 'Deed of transfer T 2210/2008'},
  createdAt: '2026-10-17T08:00:00.000Z',
  createdById: 'u-reviewer',
  approvedById: null,
};
const ITEMS = [
  [LEAF_TYPES.documentVersion, sealOf(DOCUMENT_ID, EDRMS_NO, VERSION)],
  [
    LEAF_TYPES.documentVersion,
    sha256('example: document version EDR-NA-2026-000002 v1'),
  ],
  [
    LEAF_TYPES.recordVersion,
    sha256('example: land record version LR-NA-2026-000001 v1'),
  ],
  [
    LEAF_TYPES.documentVersion,
    sha256('example: document version EDR-NA-2026-000001 v2'),
  ],
  [LEAF_TYPES.trailCheckpoint, sha256('example: trail head at entry 9')],
];
const LEAVES = ITEMS.map(([type, item]) => hex(leafHash(type, item)));
const NODE_01 = hex(nodeHash(LEAVES[0], LEAVES[1]));
const NODE_23 = hex(nodeHash(LEAVES[2], LEAVES[3]));
const PEAK_1 = hex(nodeHash(NODE_01, NODE_23));
const ROOT_5 = hex(rootOf(5, [PEAK_1, LEAVES[4]]));
const ROOT_3 = hex(rootOf(3, [NODE_01, LEAVES[2]]));

/** The guide's script (the ```js block after the root-script marker). */
function guideScript() {
  const at = guide.indexOf('<!-- root-script');
  assert.ok(at >= 0, 'the root-script marker in the guide');
  const marked = guide.slice(at);
  const fence = marked.indexOf('```js\n');
  assert.ok(fence >= 0, 'a ```js block after the marker');
  const start = fence + '```js\n'.length;
  const end = marked.indexOf('```', start);
  assert.ok(end > start, 'the end of the ```js block');
  return marked.slice(start, end);
}

/** Run a script as a reader would, in its own folder; returns what it prints. */
function run(script) {
  const dir = mkdtempSync(join(tmpdir(), 'lrfe-guide-'));
  try {
    writeFileSync(join(dir, 'root.mjs'), script);
    return execFileSync(process.execPath, [join(dir, 'root.mjs')], {
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

describe('the user guide "What is on the blockchain" (API-728)', () => {
  it("shows the document version's file hash, canonical JSON and seal as the service computes them", () => {
    assert.ok(guide.includes(VERSION.sha256), 'file SHA-256');
    const canonical = canonicalJson({
      documentId: DOCUMENT_ID,
      edrmsNo: EDRMS_NO,
      ...VERSION,
    });
    assert.ok(guide.includes(canonical), 'canonical JSON');
    assert.equal(
      sha256(canonical),
      ITEMS[0][1],
      'the seal is the SHA-256 of the canonical JSON shown',
    );
    assert.ok(guide.includes(ITEMS[0][1]), 'seal');
  });

  it('shows every seal, leaf, node, peak and root of the worked example as the tree code computes them', () => {
    for (const [, item] of ITEMS) {
      assert.ok(guide.includes(item), `seal ${item}`);
    }
    for (const leaf of LEAVES) assert.ok(guide.includes(leaf), `leaf ${leaf}`);
    for (const [name, value] of Object.entries({
      NODE_01,
      NODE_23,
      PEAK_1,
      ROOT_5,
      ROOT_3,
    })) {
      assert.ok(guide.includes(value), name);
    }
    // the shape the guide draws: five leaves = a peak of four and a peak of one; three = two and one
    assert.deepEqual(
      peaks(5).map(p => 2 ** p.height),
      [4, 1],
    );
    assert.deepEqual(
      peaks(3).map(p => 2 ** p.height),
      [2, 1],
    );
  });

  it('describes the proof of leaf 3 as the service makes and checks it: path leaf 2 then node 0–1, peaks 1 and 2', () => {
    // leaf 3 is first covered by the batch of five (leaves 0–2 were in the batch of three)
    const {path, peaks: peakPositions} = inclusionPositions(3, 5);
    assert.equal(path.length, 2);
    assert.equal(peakPositions.length, 2);
    assert.ok(
      verifyInclusion({
        leafHash: LEAVES[3],
        leafIndex: 3,
        size: 5,
        path: [LEAVES[2], NODE_01],
        peaks: [PEAK_1, LEAVES[4]],
        root: ROOT_5,
      }),
    );
    assert.ok(
      guide.includes(
        'the sibling hashes from the leaf up to its peak: leaf 2, then node 0–1',
      ),
    );
  });

  it('lists the metadata fields the service writes', () => {
    const metadata = anchorMetadata({
      root: ROOT_5,
      size: 5,
      batch: 2,
      prev: ROOT_3,
    });
    for (const field of Object.keys(metadata)) {
      assert.ok(guide.includes(`| \`${field}\` |`), `field ${field}`);
    }
    assert.equal(metadata.sys, 'lrfe-audit');
    assert.ok(guide.includes('label **8890**'));
  });

  it("its script, run as a reader would run it, prints the example's root, and the prev root with three leaves", function () {
    this.timeout(20_000);
    const script = guideScript();
    const out = run(script);
    assert.match(out, new RegExp(`^peak 1 \\(4 leaves\\): ${PEAK_1}$`, 'm'));
    assert.match(out, new RegExp(`^root \\(size 5\\): ${ROOT_5}$`, 'm'));
    assert.ok(
      guide.includes(`root (size 5): ${ROOT_5}`),
      'the expected output the guide states',
    );

    // the reader's edit the guide suggests: delete the last two leaves
    const lines = script.split('\n');
    const last = lines.findIndex(l => l.startsWith('];'));
    assert.ok(last > 2, 'the end of LEAVES in the script');
    lines.splice(last - 2, 2);
    assert.match(
      run(lines.join('\n')),
      new RegExp(`^root \\(size 3\\): ${ROOT_3}$`, 'm'),
    );
    assert.ok(
      guide.includes(`root (size 3): ${ROOT_3}`),
      'the prev output the guide states',
    );
  });
});

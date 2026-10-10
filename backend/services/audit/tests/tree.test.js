import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { TreeService } from '../src/tree.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { LEAF_TYPES, leafHash, nodeHash, rootOf, verifyConsistency, verifyInclusion } from '../src/mmr.js';

const seal = (n) => createHash('sha256').update(`item ${n}`).digest('hex');
const item = (n, type = LEAF_TYPES.documentVersion) => ({ key: `document-version:d${n}:1`, type, item: seal(n) });

function makeTree() {
    const repo = createMemoryRepo();
    const warnings = [];
    return { repo, warnings, tree: new TreeService({ repo, logger: { warn: (o, m) => warnings.push([o, m]) } }) };
}

/** The root computed the plain way, independent of positions: perfect trees over the leaves, largest first. */
function referenceRoot(leafHashes) {
    const perfect = (hs) => (hs.length === 1 ? hs[0] : nodeHash(perfect(hs.slice(0, hs.length / 2)), perfect(hs.slice(hs.length / 2))));
    const peaks = [];
    let start = 0;
    for (let h = 40; h >= 0; h--) {
        if (Math.floor(leafHashes.length / 2 ** h) % 2) { peaks.push(perfect(leafHashes.slice(start, start + 2 ** h))); start += 2 ** h; }
    }
    return rootOf(leafHashes.length, peaks).toString('hex');
}

const SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 127, 128, 129, 255, 256, 257];

describe('growing Merkle tree: roots (API-655)', () => {
    it('the root at every size matches the plain computation, also read back later at that size', async () => {
        const { tree } = makeTree();
        const hashes = [], roots = [];
        for (let n = 1; n <= 300; n++) {
            await tree.append([item(n)]);
            hashes.push(leafHash(LEAF_TYPES.documentVersion, seal(n)));
            const { root, size } = await tree.root();
            assert.equal(size, n);
            assert.equal(root, referenceRoot(hashes), `size ${n}`);
            roots.push(root);
        }
        for (const n of SIZES) assert.equal((await tree.root(n)).root, roots[n - 1], `root of size ${n} read later`);
    });

    it('adding in batches gives the same tree as adding one by one', async () => {
        const one = makeTree(), batch = makeTree();
        for (let n = 1; n <= 77; n++) await one.tree.append([item(n)]);
        await batch.tree.append(Array.from({ length: 30 }, (_, k) => item(k + 1)));
        await batch.tree.append(Array.from({ length: 47 }, (_, k) => item(k + 31)));
        assert.deepEqual(await batch.tree.root(), await one.tree.root());
        assert.deepEqual(batch.repo.nodes, one.repo.nodes);
    });

    it('a key is added once: repeats, also within a batch, add nothing', async () => {
        const { tree, warnings } = makeTree();
        assert.equal((await tree.append([item(1), item(2), item(1)])).length, 2);
        assert.equal((await tree.append([item(2)])).length, 0);
        assert.equal(await tree.size(), 2);
        assert.equal(warnings.length, 0);
    });

    it('a key that comes back with another seal keeps the first and is reported', async () => {
        const { tree, warnings } = makeTree();
        await tree.append([item(1)]);
        assert.equal((await tree.append([{ ...item(1), item: seal(99) }])).length, 0);
        assert.equal((await tree.inclusionProof(item(1).key)).leaf.item, seal(1));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0][1], /different seal/);
    });

    it('the leaf type is part of the leaf: the same 32 bytes as another kind is another leaf', () => {
        assert.notEqual(leafHash(LEAF_TYPES.recordVersion, seal(1)).toString('hex'), leafHash(LEAF_TYPES.documentVersion, seal(1)).toString('hex'));
        assert.throws(() => leafHash(9, seal(1)), /unknown leaf type/);
    });

    it('refuses what is not a leaf, and sizes it does not have', async () => {
        const { tree } = makeTree();
        await assert.rejects(tree.append([{ key: 'x', type: 1, item: 'not-hex' }]), e => e.statusCode === 400);
        await assert.rejects(tree.append([{ key: 'x', type: 7, item: seal(1) }]), e => e.statusCode === 400);
        await tree.append([item(1)]);
        await assert.rejects(tree.root(2), e => e.statusCode === 400);
        await assert.rejects(tree.inclusionProof('document-version:nope:1'), e => e.statusCode === 404);
        await assert.rejects(tree.consistencyProof(0), e => e.statusCode === 400);
    });

    it('an empty tree has a root too (size 0)', async () => {
        assert.equal((await makeTree().tree.root()).root, rootOf(0, []).toString('hex'));
    });
});

describe('growing Merkle tree: inclusion proofs (API-655)', () => {
    it('every leaf has a proof at every size from its own on (1, 2, 3, powers of two and in between)', async () => {
        const { tree } = makeTree();
        await tree.append(Array.from({ length: 257 }, (_, k) => item(k + 1)));
        for (const n of SIZES) {
            for (let i = 1; i <= n; i++) {
                const p = await tree.inclusionProof(`document-version:d${i}:1`, n);
                const ok = verifyInclusion({ leafHash: p.leaf.hash, leafIndex: p.leaf.index, size: p.size, path: p.path, peaks: p.peaks, root: (await tree.root(n)).root });
                assert.equal(ok, true, `leaf ${i - 1} in size ${n}`);
                assert.ok(p.path.length <= Math.ceil(Math.log2(n)));
            }
        }
        await assert.rejects(tree.inclusionProof('document-version:d200:1', 100), e => e.statusCode === 400);   // added later
    });

    it('a changed leaf, a changed or shortened path, a wrong position or another root fail', async () => {
        const { tree } = makeTree();
        await tree.append(Array.from({ length: 100 }, (_, k) => item(k + 1)));
        const p = await tree.inclusionProof('document-version:d42:1');
        const args = { leafHash: p.leaf.hash, leafIndex: p.leaf.index, size: p.size, path: p.path, peaks: p.peaks, root: p.root };
        assert.equal(verifyInclusion(args), true);
        assert.equal(verifyInclusion({ ...args, leafHash: leafHash(LEAF_TYPES.documentVersion, seal(4242)).toString('hex') }), false);
        assert.equal(verifyInclusion({ ...args, leafHash: leafHash(LEAF_TYPES.recordVersion, seal(42)).toString('hex') }), false);
        assert.equal(verifyInclusion({ ...args, path: [seal(0), ...p.path.slice(1)] }), false);
        assert.equal(verifyInclusion({ ...args, path: p.path.slice(1) }), false);
        assert.equal(verifyInclusion({ ...args, leafIndex: p.leaf.index + 1 }), false);
        assert.equal(verifyInclusion({ ...args, size: p.size + 1 }), false);
        assert.equal(verifyInclusion({ ...args, root: seal(1) }), false);
        assert.equal(verifyInclusion({ ...args, path: 'nonsense' }), false);
    });

    it('a missing or reordered leaf: the proofs no longer match the root anchored before', async () => {
        const original = makeTree();
        const items = Array.from({ length: 50 }, (_, k) => item(k + 1));
        await original.tree.append(items);
        const anchored = (await original.tree.root()).root;

        const missing = makeTree();                                   // leaf 20 left out
        await missing.tree.append(items.filter((_, k) => k !== 20));
        await missing.tree.append([item(999)]);                       // same size again
        assert.notEqual((await missing.tree.root()).root, anchored);
        const p = await missing.tree.inclusionProof('document-version:d30:1');
        assert.equal(verifyInclusion({ leafHash: p.leaf.hash, leafIndex: p.leaf.index, size: p.size, path: p.path, peaks: p.peaks, root: anchored }), false);

        const reordered = makeTree();                                 // leaves 10 and 11 swapped
        const swapped = [...items];
        [swapped[10], swapped[11]] = [swapped[11], swapped[10]];
        await reordered.tree.append(swapped);
        assert.notEqual((await reordered.tree.root()).root, anchored);
        const q = await reordered.tree.inclusionProof('document-version:d11:1');
        assert.equal(verifyInclusion({ leafHash: q.leaf.hash, leafIndex: q.leaf.index, size: q.size, path: q.path, peaks: q.peaks, root: anchored }), false);
    });

    it('a node changed in storage gives proofs that fail against the earlier root', async () => {
        const { repo, tree } = makeTree();
        await tree.append(Array.from({ length: 64 }, (_, k) => item(k + 1)));
        const anchored = (await tree.root()).root;
        repo.nodes[5] = Buffer.alloc(32, 7);
        const p = await tree.inclusionProof('document-version:d1:1');
        assert.equal(verifyInclusion({ leafHash: p.leaf.hash, leafIndex: p.leaf.index, size: p.size, path: p.path, peaks: p.peaks, root: anchored }), false);
    });
});

describe('growing Merkle tree: consistency proofs (API-655)', () => {
    it('every earlier size is the start of every later size', async () => {
        const { tree } = makeTree();
        await tree.append(Array.from({ length: 40 }, (_, k) => item(k + 1)));
        for (let m = 1; m <= 40; m++) {
            for (let n = m; n <= 40; n++) {
                const c = await tree.consistencyProof(m, n);
                assert.equal(c.oldRoot, (await tree.root(m)).root);
                assert.equal(verifyConsistency(c), true, `${m} → ${n}`);
            }
        }
    });

    it('also across larger sizes (powers of two and around them)', async () => {
        const { tree } = makeTree();
        await tree.append(Array.from({ length: 1100 }, (_, k) => item(k + 1)));
        for (const [m, n] of [[1, 1100], [511, 512], [512, 513], [513, 1024], [1000, 1023], [1023, 1024], [1024, 1025], [777, 1100]]) {
            assert.equal(verifyConsistency(await tree.consistencyProof(m, n)), true, `${m} → ${n}`);
        }
    });

    it('a changed, missing or reordered earlier leaf fails the proof against the earlier root', async () => {
        const items = Array.from({ length: 30 }, (_, k) => item(k + 1));
        const original = makeTree();
        await original.tree.append(items.slice(0, 20));
        const anchored = await original.tree.root();                  // { size: 20, root }

        const tampered = async (list) => {
            const t = makeTree();
            await t.tree.append(list);
            const c = await t.tree.consistencyProof(20);
            return verifyConsistency({ ...c, oldRoot: anchored.root });
        };
        assert.equal(await tampered(items), true);                                                // honest growth
        assert.equal(await tampered(items.map((it, k) => (k === 7 ? item(707) : it))), false);    // changed
        assert.equal(await tampered(items.filter((_, k) => k !== 7)), false);                     // missing
        const swapped = [...items]; [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
        assert.equal(await tampered(swapped), false);                                             // reordered

        const c = await original.tree.consistencyProof(5, 20);
        assert.equal(verifyConsistency({ ...c, paths: c.paths.map(p => p.map(() => seal(0))) }), c.paths.flat().length === 0);
        assert.equal(verifyConsistency({ ...c, newRoot: seal(3) }), false);
        assert.equal(verifyConsistency({ ...c, oldPeaks: [...c.oldPeaks, seal(5)] }), false);            // one peak too many
        assert.equal(verifyConsistency({ ...c, newPeaks: c.newPeaks.slice(1) }), false);                  // one too few
        assert.equal(verifyConsistency({ ...c, oldPeaks: c.oldPeaks.map(() => seal(6)) }), false);        // forged old peaks
        assert.equal(verifyConsistency({ ...c, oldSize: 6 }), false);
    });
});

describe('growing Merkle tree: leaf sources (API-655)', () => {
    const ev = (type, data) => ({ id: randomUUID(), type, source: type.split('.')[0], time: new Date().toISOString(), actor: { id: 'u1' }, data });

    it('a committed land record version, a filed document and each amendment become leaves; other events do not', async () => {
        const { tree } = makeTree();
        assert.equal((await tree.fromEvent(ev('records.record.committed', { recordId: 'r1', versionNumber: 2, seal: seal(1) }))).key, 'record-version:r1:2');
        assert.equal((await tree.fromEvent(ev('edrms.document.filed', { documentId: 'd1', seal: seal(2) }))).key, 'document-version:d1:1');
        assert.equal((await tree.fromEvent(ev('edrms.document.amended', { documentId: 'd1', version: 2, seal: seal(3) }))).key, 'document-version:d1:2');
        assert.equal(await tree.fromEvent(ev('records.draft.changed', { recordId: 'r1' })), null);
        assert.equal(await tree.fromEvent(ev('edrms.document.filed', { documentId: 'd2' })), null);       // no seal
        const repeat = ev('records.record.committed', { recordId: 'r1', versionNumber: 2, seal: seal(1) });
        assert.equal(await tree.fromEvent(repeat), null);                                                  // redelivered
        assert.equal(await tree.size(), 3);
        const p = await tree.inclusionProof('record-version:r1:2');
        assert.deepEqual([p.leaf.type, p.leaf.item], [LEAF_TYPES.recordVersion, seal(1)]);
    });

    it('a trail checkpoint is a leaf of its own type, once per trail position', async () => {
        const { tree } = makeTree();
        const head = { seq: 375, hash: seal(375) };
        assert.equal((await tree.checkpoint(head)).type, LEAF_TYPES.trailCheckpoint);
        assert.equal(await tree.checkpoint(head), null);
        await assert.rejects(tree.checkpoint({ seq: 1 }), e => e.statusCode === 400);
    });
});

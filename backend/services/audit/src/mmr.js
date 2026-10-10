import { createHash } from 'node:crypto';

/**
 * Merkle mountain range arithmetic and proof checking (README.md section 2). Pure functions: no
 * storage. Nodes are numbered in post-order (0, 1, 2 …: a parent right after its two children),
 * so a tree of n leaves has 2n − popcount(n) nodes and positions never change as it grows.
 *
 *   leaf = SHA-256( 0x00 || type || item )         item: 32 bytes (a seal or a trail hash)
 *   node = SHA-256( 0x01 || left || right )
 *   root = SHA-256( 0x02 || size (8 bytes, big-endian) || peaks, largest first )
 */
export const LEAF_TYPES = { recordVersion: 1, documentVersion: 2, trailCheckpoint: 3 };

const sha256 = (...parts) => {
    const h = createHash('sha256');
    for (const p of parts) h.update(p);
    return h.digest();
};
const toBuf = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'hex'));
const HEX64 = /^[0-9a-f]{64}$/;

export function leafHash(type, item) {
    if (!Object.values(LEAF_TYPES).includes(type)) throw new Error(`unknown leaf type ${type}`);
    if (!Buffer.isBuffer(item) && !HEX64.test(item)) throw new Error('a leaf item is 32 bytes (64 hex characters)');
    return sha256(Buffer.from([0x00, type]), toBuf(item));
}

export const nodeHash = (left, right) => sha256(Buffer.from([0x01]), toBuf(left), toBuf(right));

export function rootOf(size, peaks) {
    const s = Buffer.alloc(8);
    s.writeBigUInt64BE(BigInt(size));
    return sha256(Buffer.from([0x02]), s, ...peaks.map(toBuf));
}

const popcount = (n) => { let c = 0; for (let x = BigInt(n); x; x &= x - 1n) c++; return c; };
const span = (h) => 2 ** (h + 1) - 1;                 // nodes in a perfect tree of height h

export const leafPos = (i) => 2 * i - popcount(i);
export const nodeCount = (n) => 2 * n - popcount(n);

/** The peaks of a tree of `size` leaves, largest first: { height, pos, leafStart }. */
export function peaks(size) {
    const out = [];
    let offset = 0, leafStart = 0;
    for (let h = 52; h >= 0; h--) {
        if (Math.floor(size / 2 ** h) % 2 === 1) {
            out.push({ height: h, pos: offset + span(h) - 1, leafStart });
            offset += span(h);
            leafStart += 2 ** h;
        }
    }
    return out;
}

/** The peak (index into peaks(size)) holding leaf `i`. */
function peakOf(i, size) {
    const ps = peaks(size);
    const index = ps.findIndex(p => i >= p.leafStart && i < p.leafStart + 2 ** p.height);
    return { index, peak: ps[index], peaks: ps };
}

/**
 * Climb from a node at height `from` (position `pos`, number `j` among the nodes of that height in
 * its peak) to the peak of height `to`: the siblings' positions, and for each whether ours is the
 * left child.
 */
function climb(pos, j, from, to) {
    const steps = [];
    let p = pos;
    for (let level = from; level < to; level++) {
        const left = Math.floor(j / 2 ** (level - from)) % 2 === 0;
        const sibling = left ? p + span(level) : p - span(level);
        steps.push({ sibling, left });
        p = left ? sibling + 1 : p + 1;
    }
    return { steps, top: p };
}

function fold(hash, steps, path) {
    let cur = toBuf(hash);
    steps.forEach((s, k) => { cur = s.left ? nodeHash(cur, path[k]) : nodeHash(path[k], cur); });
    return cur;
}

/** Positions an inclusion proof of leaf `i` in the tree of `size` leaves needs. */
export function inclusionPositions(i, size) {
    if (!(i >= 0 && i < size)) throw new RangeError(`leaf ${i} is not in a tree of ${size}`);
    const { index, peak, peaks: ps } = peakOf(i, size);
    const { steps, top } = climb(leafPos(i), i - peak.leafStart, 0, peak.height);
    if (top !== peak.pos) throw new Error('internal: climb did not end at the peak');
    return { peakIndex: index, path: steps.map(s => s.sibling), peaks: ps.map(p => p.pos) };
}

/** Positions a consistency proof from `oldSize` to `newSize` needs: per old peak, its climb. */
export function consistencyPositions(oldSize, newSize) {
    if (!(oldSize >= 1 && oldSize <= newSize)) throw new RangeError(`no consistency proof from ${oldSize} to ${newSize}`);
    const fresh = peaks(newSize);
    return {
        oldPeaks: peaks(oldSize).map(p => p.pos),
        newPeaks: fresh.map(p => p.pos),
        paths: peaks(oldSize).map(p => {
            const { peak } = peakOf(p.leafStart, newSize);
            return climb(p.pos, (p.leafStart - peak.leafStart) / 2 ** p.height, p.height, peak.height).steps.map(s => s.sibling);
        })
    };
}

const eq = (a, b) => toBuf(a).equals(toBuf(b));
const allHex = (list, n) => Array.isArray(list) && (n === undefined || list.length === n) && list.every(x => typeof x === 'string' && HEX64.test(x));

/**
 * Check an inclusion proof: the leaf `leafHash` at `leafIndex` is in the tree of `size` whose root
 * is `root`. `path` and `peaks` are hex. True or false, never throws on bad input.
 */
export function verifyInclusion({ leafHash: leaf, leafIndex, size, path, peaks: peakHashes, root }) {
    try {
        if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(size) || leafIndex < 0 || leafIndex >= size) return false;
        const { index, peak, peaks: ps } = peakOf(leafIndex, size);
        if (!allHex(path, peak.height) || !allHex(peakHashes, ps.length)) return false;
        const { steps } = climb(leafPos(leafIndex), leafIndex - peak.leafStart, 0, peak.height);
        return eq(fold(leaf, steps, path), peakHashes[index]) && eq(rootOf(size, peakHashes), root);
    } catch { return false; }
}

/** Check a consistency proof: the tree of `oldSize` (root `oldRoot`) is the start of the tree of `newSize` (root `newRoot`). */
export function verifyConsistency({ oldSize, oldRoot, newSize, newRoot, oldPeaks, newPeaks, paths }) {
    try {
        if (!Number.isSafeInteger(oldSize) || !Number.isSafeInteger(newSize) || oldSize < 1 || oldSize > newSize) return false;
        const before = peaks(oldSize), after = peaks(newSize);
        if (!allHex(oldPeaks, before.length) || !allHex(newPeaks, after.length) || !Array.isArray(paths) || paths.length !== before.length) return false;
        if (!eq(rootOf(oldSize, oldPeaks), oldRoot) || !eq(rootOf(newSize, newPeaks), newRoot)) return false;
        return before.every((p, k) => {
            const { index, peak } = peakOf(p.leafStart, newSize);
            if (!allHex(paths[k], peak.height - p.height)) return false;
            const { steps } = climb(p.pos, (p.leafStart - peak.leafStart) / 2 ** p.height, p.height, peak.height);
            return eq(fold(oldPeaks[k], steps, paths[k]), newPeaks[index]);
        });
    } catch { return false; }
}

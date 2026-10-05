import { canonicalJson, sha256Hex } from '@lrfe/common';

/**
 * The seal of a committed version (README.md section 7): SHA-256 over the canonical JSON of the
 * whole version, including the pinned documents with their own seals and field snapshots, who
 * submitted and approved it, when, and the previous version's seal. Each seal therefore depends on
 * every version before it: changing an earlier version breaks all later seals.
 */
export function sealOf(record, version) {
    return sha256Hex(canonicalJson({
        recordId: record.id,
        recordNo: record.recordNo,
        versionNumber: version.versionNumber,
        data: version.data,
        submittedById: version.submittedById ?? null,
        approvedById: version.approvedById ?? null,
        committedAt: new Date(version.committedAt).toISOString(),
        previousSeal: version.previousSeal ?? null
    }));
}

/**
 * Recompute the chain of committed versions (oldest first). Returns one entry per version:
 * { versionNumber, seal, intact, linked } — `intact`: the stored seal matches the content;
 * `linked`: its previousSeal is the seal of the version before.
 */
export function verifyChain(record, committed) {
    let previous = null;
    return committed.map(v => {
        const intact = sealOf(record, v) === v.seal;
        const linked = (v.previousSeal ?? null) === previous;
        previous = v.seal;
        return { versionNumber: v.versionNumber, seal: v.seal, intact, linked };
    });
}

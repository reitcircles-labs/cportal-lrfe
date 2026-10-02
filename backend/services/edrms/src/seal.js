import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

/**
 * The seal of one version: SHA-256 over the content hash AND the metadata that version asserts.
 * Changing a single byte of the file, a field value or the record metadata breaks it.
 */
export function sealOf(documentId, edrmsNo, version) {
    return sha256Hex(canonicalJson({
        documentId,
        edrmsNo,
        versionNumber: version.versionNumber,
        sha256: version.sha256,
        fields: version.fields,
        recordMetadata: version.recordMetadata,
        createdAt: new Date(version.createdAt).toISOString(),
        createdById: version.createdById ?? null,
        approvedById: version.approvedById ?? null,
        // Only present when the filing carried it: versions without provenance keep their seal.
        provenance: version.provenance ?? undefined
    }));
}

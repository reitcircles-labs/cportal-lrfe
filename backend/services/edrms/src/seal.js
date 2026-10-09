import { canonicalJson, sha256Hex } from '@lrfe/common';

// canonical JSON and SHA-256 are shared with land-records (@lrfe/common)
export { canonicalJson, sha256Hex };

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

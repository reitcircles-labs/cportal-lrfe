// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

export const ENDPOINTS = {
  title: 'extracts',
  description:
    "Ownership extracts: the register of extracts issued for an owner on a land record's current approved version once it is on the blockchain, each valid or revoked. Design: services/extracts/README.md.",
  tags: {
    Extracts: 'The register of ownership extracts.',
    'Public check':
      "Checking an extract from its QR code, with no sign-in (through the gateway's rate-limited /api/public).",
    Service: 'Health and metadata.',
  },
  routes: {
    'GET /health': {tag: 'Service', summary: 'Health check', auth: 'public'},
    'POST /extracts': {
      tag: 'Extracts',
      summary:
        "Issue an extract of a land record's current version for an owner",
      description:
        "`{ recordId, versionNumber, ownerIndex, idNo, documentSeen }`: the owner chosen on the current version, the ID number typed from the identity document shown, and `documentSeen: true`. 201 with the register row: `id`, `recordId`, `recordNo`, `versionNumber`, `issuedById`, `issuedByName`, `ownerIndex`, `ownerName`, `ownerIdLast4` (the last four characters of the owner's ID number; the rest is not kept), `documentSeen`, `issuedAt`, `token` (random, for the public check), `status` `valid`, `pdfSha256` (the SHA-256 of the sealed PDF, also in the issued event), `isCurrentVersion`. The extract's PDF, sealed by the registry with the version's proof attached, is made and stored first; `GET /extracts/{id}/pdf` gives it. 400 without `documentSeen: true`. 409 when the record has no approved version, `versionNumber` is no longer the current one, there is no such owner, the ID number does not match the owner's on the version, or the version is not on the blockchain yet (its anchoring confirmed); 503 when that cannot be checked, the proof cannot be read, or the registry's seal is not set up or cannot be applied now; 404 when there is no such record.",
    },
    'GET /extracts': {
      tag: 'Extracts',
      summary: 'The extracts of a land record, newest first',
      description:
        "`{ items }`: the register rows of `recordId`, valid and revoked (`revokedAt`, `revokedByName`, `revokeReason`), each with `isCurrentVersion`: its version is still the record's current one.",
    },
    'GET /public/extracts/{token}': {
      tag: 'Public check',
      summary: 'Check an extract by its token, from its QR code',
      description:
        "One state, always 200 and always the same fields (null where they do not apply): `{ state, extractId, recordNo, versionNumber, issuedAt, fingerprintEnd, batch, transactionId, explorerUrl, replacedAt, revokedAt, checkedAt }`. `state`: `current` (the version's seal, held by land-records, is in a confirmed batch on the blockchain and the version is the record's current one), `replaced` (the same, but the record has a newer version: `replacedAt` is when the version after the extract's was committed), `revoked` (withdrawn on `revokedAt`; the reason is not given), `mismatch` (a check failed), `unknown` (no such extract; every other field null) or `unavailable` (it cannot be checked right now). `fingerprintEnd` is the last 8 characters of the version's seal. Never the owners, their ID numbers or shares, or the parcel.",
      auth: 'public',
    },
    'GET /public/extracts/seal': {
      tag: 'Public check',
      summary:
        "The registry's seal certificate, to compare an extract's seal with",
      description:
        '`{ subject, sha256, validFrom, validTo }`: `sha256` is the SHA-256 of the seal certificate (DER), lowercase hex, the fingerprint the offline verifier takes (`node lrfe-verify.mjs extract.pdf --address <wallet> --seal <sha256>`). An extract sealed with another certificate, even one with the same name, is not valid. 503 when no seal is set up.',
      auth: 'public',
    },
    'GET /extracts/{id}/pdf': {
      tag: 'Extracts',
      summary: 'Download an extract again: its sealed PDF as issued',
      description:
        "`application/pdf`, as an attachment: the exact bytes issued, checked against `pdfSha256` in the register. The PDF carries the registry's electronic seal (a PAdES signature) and, attached inside, the version's proof (`record-v<n>.proof.json`). 409 when the extract is revoked; 404 when there is no such extract.",
    },
    'POST /extracts/{id}/revoke': {
      tag: 'Extracts',
      summary: 'Revoke an extract, with the reason',
      description:
        '`{ reason }`. The updated register row, `status` `revoked`; it stays in the register. 409 when it is already revoked. `isCurrentVersion` is null when the land record cannot be read just after the revocation is saved.',
    },
  },
};

# extracts service

*Ownership extracts (epic API-689). The register and its staff endpoints are built in API-692; the
extract's PDF is API-691, the screens (Issue extract on the land record page, the register list)
wait for the design, API-690.*

An ownership extract states who owns a parcel, as the land record's **current committed version**
says. It is issued at the counter for one of the owners, once their identity document has been seen,
and is recorded in a register. Port 3507, own schema `extracts`, `/api/extracts` through the gateway.

## Issuing

`POST /extracts` with `{ recordId, versionNumber, ownerIndex, idNo, documentSeen }`, permission
`extract.issue` (the Records officer role). The staff member picks an owner on the current version
(`ownerIndex`, its place in the version's owners), types the ID number from the identity document
they were shown, and confirms they have seen it (`documentSeen: true`). The service:

1. reads the record from land-records with its own service token (`GET /records/:id`);
2. refuses when the record has no committed version, `versionNumber` is no longer the current
   one, there is no such owner, the owner has no ID number on the version, or the typed ID number
   (spaces and dashes aside) is not the owner's;
3. asks the audit service whether the version is on the blockchain (`POST /audit/anchoring`, key
   `record-version:<id>:<n>`) and refuses until its anchoring is **confirmed**; when the audit
   service cannot be asked, it refuses with 503 rather than issue unchecked;
4. writes the register row and publishes `extracts.extract.issued` in one transaction (outbox).

## The register

Table `extracts.extract`, one row per extract, never deleted: `id`, `recordId`, `recordNo`,
`versionNumber`, `issuedById`, `issuedByName`, `ownerIndex`, `ownerName`, `ownerIdLast4` (the last
four characters of the owner's ID number: the full number is not kept), `documentSeen`,
`issuedAt`, `token` (32 random bytes, URL-safe, unique: the public check of an extract will find it
by this), `status` `valid` | `revoked`, `revokedAt`, `revokedById`, `revokedByName`,
`revokeReason`.

`GET /extracts?recordId=` lists a record's extracts newest first. Every row returned also has
`isCurrentVersion`: its version is still the record's current one (a valid extract of a replaced
version is still valid, but no longer shows the current owners).

`POST /extracts/:id/revoke` with `{ reason }` revokes a valid extract (409 when it is already
revoked) and publishes `extracts.extract.revoked`. When the land record cannot be read just after
the revocation is saved, the row comes back with `isCurrentVersion: null` rather than an error.

## Events

Both events carry `extractId`, `recordId`, `recordNo` and `versionNumber` (issued: also
`issuedFor: { name }`; revoked: `reason`), never the token or the ID number. The audit service reads
them like every durable event, so they are in the land record's trail.

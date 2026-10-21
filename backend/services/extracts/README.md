# extracts service

*Ownership extracts (epic API-689). The register and its staff endpoints are built in API-692, the
public check's endpoint in API-693; the extract's PDF is API-691, the screens (Issue extract on the
land record page, the register list, the public check page) wait for the design, API-690.*

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

## The public check

`GET /public/extracts/:token` (`/api/public/extracts/:token` through the gateway) needs no sign-in:
anyone holding the extract scans its QR code, which carries the token. The gateway forwards only
GET on that path, without the caller's credentials, and rate-limits it per client address; nothing
else of the service is reachable without a sign-in. The answer is one state, always with the same
fields, null where they do not apply:

| `state` | When | Also given |
|---|---|---|
| `current` | the version checked now matches and is the record's current one | `fingerprintEnd`, `batch`, `transactionId`, `explorerUrl` |
| `replaced` | it matches, but the record has a newer version | the same, and `replacedAt`: when the current version was committed |
| `revoked` | the registry withdrew it | `revokedAt` (never the reason, which may name people) |
| `mismatch` | a check failed: the version's data or seal no longer matches what is on the blockchain | |
| `unknown` | no extract has this token (or it is not a token at all) | nothing: every other field null |
| `unavailable` | the register, land-records or the audit service cannot be read now, or a check cannot be made now | |

Every state but `unknown` also gives `extractId`, `recordNo`, `versionNumber` and `issuedAt` from
the register; never the owner's name, ID number or share, or the parcel. `fingerprintEnd` is the
last 8 characters of the version's seal.

For a valid extract the service reads the record from land-records (`GET /records/:id`) and asks
the audit service to check the version now (`POST /audit/anchoring/check`, with its service
token): the seal recomputed by land-records from the version's data equals the seal in the audit
tree, the path to the anchored root holds, and the root is in the transaction on the blockchain. It
answers `current` or `replaced` only when all of that holds and the batch is confirmed, and the
current version's seal in land-records is the one checked. A check that fails is `mismatch`; one
that cannot be made now is `unavailable`, never `current`.

Each check is logged (`extract checked`) with its state and the extract's id, and for
`unavailable` or `mismatch` which part was the cause (`register`, `land-records`, `audit`); never
personal data. There is no search: the token is the only way in.

## Events

Both events carry `extractId`, `recordId`, `recordNo` and `versionNumber` (issued: also
`issuedFor: { name }`; revoked: `reason`), never the token or the ID number. The audit service reads
them like every durable event, so they are in the land record's trail.

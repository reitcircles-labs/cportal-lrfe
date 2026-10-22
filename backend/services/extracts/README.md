# extracts service

*Ownership extracts (epic API-689). The register and its staff endpoints are built in API-692, the
public check's endpoint in API-693, the extract's sealed PDF in API-691; the screens (Issue extract
on the land record page, the register list with "Download again", the public check page) wait for
the design, API-690.*

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
4. reads the version's proof from the audit service (`POST /audit/anchoring/proof`, with its
   service token): the proof must be confirmed and for the seal land-records holds for the version;
5. makes the extract's PDF, seals it with the organisation seal and stores it (below); refuses with
   503 when no seal is set up or the seal cannot be applied now, and when the proof cannot be read;
6. writes the register row and publishes `extracts.extract.issued` in one transaction (outbox). When
   that fails, the stored PDF is deleted again.

The answer is the register row (201); `GET /extracts/:id/pdf` gives the PDF.

## The register

Table `extracts.extract`, one row per extract, never deleted: `id`, `extractNo`
(`EX-<country>-<year>-<nnnnnn>`, printed on the extract, API-692), `checkCode` (12 characters
without I, L, O or U, printed on the extract for typing in on the check page), `recordId`, `recordNo`,
`versionNumber`, `issuedById`, `issuedByName`, `ownerIndex`, `ownerName`, `ownerIdLast4` (the last
four characters of the owner's ID number: the full number is not kept), `documentSeen`,
`issuedAt`, `token` (32 random bytes, URL-safe, unique: the public check of an extract will find it
by this), `status` `valid` | `revoked`, `revokedAt`, `revokedById`, `revokedByName`,
`revokeReason`, `pdfSha256` (the SHA-256 of the sealed PDF as issued) and `pdfKey` (where the PDF
is stored; never in an answer).

The number comes from table `extracts.counter` (one row per year): it is taken while the PDF is
made, sealed and stored, and the row is written in the same transaction, so a failed issue uses no
number and the numbers have no gaps.

`GET /extracts?recordId=` lists a record's extracts newest first. Every row returned also has
`isCurrentVersion`: its version is still the record's current one (a valid extract of a replaced
version is still valid, but no longer shows the current owners).

`POST /extracts/:id/revoke` with `{ reason }` revokes a valid extract (409 when it is already
revoked) and publishes `extracts.extract.revoked`. When the land record cannot be read just after
the revocation is saved, the row comes back with `isCurrentVersion: null` rather than an error.

## The PDF

Made on the server with pdf-lib (`src/pdf/extract-pdf.js`), one A4 page (more for many owners,
with the footer on each), as the design draft of API-690 lays it out:

- the registry's name and subtitle (the site's settings, below), "Ownership extract", the extract's
  id and the issue date and time;
- the land record's version as it stands: parcel, land record number and version, township,
  registration division, extent, tenure, the title deed(s) the owners hold under;
- the registered owners with their shares; of each ID number only the last 4 digits
  (`•••••••0418`): the full number is nowhere in the file. "Issued to <owner>, registered owner,
  identity document seen at the counter.";
- the check against the blockchain: a QR code holding the public check page's address
  `<EXTRACTS_CHECK_URL_BASE>/<token>`, the same address printed for typing in, and the version's
  fingerprint (its seal) in full, its batch and since when it is on the blockchain, the transaction
  id and the explorer link. The design's short typed check code is not there: it needs a lookup of
  its own; the address with the token is printed instead;
- the "Always scan the QR code" box, the seal notice ("Electronic seal", naming the registry) and
  the legal wording
  (`EXTRACTS_LEGAL_TEXT`; until it is set, a placeholder says it is to be confirmed by the
  registry's legal advisers);
- attached inside the file, `record-v<n>.proof.json`: the version's proof, byte for byte as the
  evidence pack holds it (`proofs/record-v<n>.json`), so the extract can be checked offline:
  `node lrfe-verify.mjs extract.pdf --address <published wallet> --seal <seal fingerprint>` (the
  audit service's offline verifier, API-694).

The texts (`src/pdf/wording.js`) say "blockchain", never the network, and name no tool behind the
portal. Characters the standard PDF fonts cannot print are written as the closest ones they can: a
Khoekhoe click as typed on a keyboard (ǃ "!", ǀ "|", ǁ "||", ǂ "‡"), a letter without its accents
or stroke; "?" only for a character with no such form.

## The seal

The PDF carries the registry's **organisation seal**: a PAdES baseline (B-B) signature, SubFilter
`ETSI.CAdES.detached`, over the whole file but the signature itself. It is a detached CMS
SignedData (`src/seal/cms.js`) with the seal certificate and three signed attributes: the content
type, the digest of the signed bytes, and the certificate's hash (signing-certificate-v2); the
signing time is the signature's `/M`, the issue date. @signpdf places the signature in the PDF; the
CMS is built with pkijs. A `Sealer` (`src/seal/sealers.js`) signs the signed attributes:

| `EXTRACTS_SEAL` | Sealer |
|---|---|
| `bao` | The key `EXTRACTS_SEAL_KEY` (default `extracts-seal`, ECDSA P-256 or RSA, never exportable) in OpenBao's transit engine. The service logs in with its own AppRole (`BAO_ADDR`, `BAO_ROLE_ID`, `BAO_SECRET_ID_FILE`) and sends only the SHA-256 digest of the signed attributes (`transit/sign`, prehashed): neither the key nor the PDF leaves where it is. The seal certificate for that key, PEM, is in `EXTRACTS_SEAL_CERT` (`\n` for line breaks) or the file `EXTRACTS_SEAL_CERT_FILE`; before the first signature the key's public key is checked against it. |
| not set | Outside production: a test seal, a key made at start with a self-signed certificate "… (test seal, not valid)", for the tests, development and the e2e stack. With `NODE_ENV=production`: none, and issuing is refused ("the registry's electronic seal is not set up"). |

The audit trail records the PDF's SHA-256 in the issued event.

**The seal's fingerprint** (API-694): `GET /public/extracts/seal` (`/api/public/extracts/seal`
through the gateway, no sign-in, rate-limited like the public check) answers `{ subject, sha256,
validFrom, validTo }` of the seal certificate; `sha256` is the SHA-256 of the certificate (DER),
lowercase hex, the fingerprint the offline verifier takes with `--seal`. 503 when no seal is set
up. Replacing the seal certificate changes the fingerprint: extracts sealed before then are checked
with the fingerprint of their time.

## Download again

The sealed PDF is stored as issued, as edrms and intake store their files (`@lrfe/storage`):
`EXTRACTS_STORAGE` `local` (a folder, `EXTRACTS_LOCAL_DIR`; the containers' `extracts-files`
volume), `memory` or `s3`, under `extracts/<id>/v1/extract.pdf`. `GET /extracts/:id/pdf`
(`extract.issue`) gives back exactly those bytes, after checking them against `pdfSha256`; never
re-rendered or re-sealed. A revoked extract is not given out again (409).

## Settings

| Setting | |
|---|---|
| `LRFE_ORG_NAME`, `LRFE_ORG_SUBTITLE` | The registry's name on the extract and in its seal notice, as identity and audit read them |
| `EXTRACTS_CHECK_URL_BASE` | The public check page the QR code opens; not set: `<LRFE_PUBLIC_URL>/#/check`. One of the two is required with `NODE_ENV=production` |
| `EXTRACTS_LEGAL_TEXT` | What the extract certifies; a placeholder until the registry has confirmed it |
| `EXTRACTS_TIME_ZONE` | The IANA time zone of the dates printed, e.g. `Africa/Windhoek` (the server's when unset); also the year of the extract number |
| `EXTRACTS_COUNTRY_CODE` | The country in the extract number, e.g. `NA` (the default); the bundle sets it from `LRFE_COUNTRY_CODE` |
| `EXTRACTS_SEAL`, `EXTRACTS_SEAL_KEY`, `EXTRACTS_SEAL_CERT`, `EXTRACTS_SEAL_CERT_FILE`, `BAO_*` | The seal, above |
| `EXTRACTS_STORAGE`, `EXTRACTS_LOCAL_DIR` | Where the PDFs are kept, above |

## The public check

`GET /public/extracts/:token` (`/api/public/extracts/:token` through the gateway) needs no sign-in:
anyone holding the extract scans its QR code, which carries the token, or types the check code
printed on it (spaces, dashes and lower case don't matter; O is read as 0, I and L as 1). The
gateway forwards only
GET on that path, without the caller's credentials, and rate-limits it per client address; nothing
else of the service is reachable without a sign-in. The answer is one state, always with the same
fields, null where they do not apply:

| `state` | When | Also given |
|---|---|---|
| `current` | the version checked now matches and is the record's current one | `fingerprintEnd`, `batch`, `transactionId`, `explorerUrl` |
| `replaced` | it matches, but the record has a newer version | the same, and `replacedAt`: when the version after the extract's was committed (for an extract of version 1 with version 3 current, version 2's date) |
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
current version's seal in land-records is the one checked. For `replaced` it also reads the version
after the extract's (`GET /records/:id/versions/:n`, which land-records lets the extracts service
read, like the record itself) for its commit date. A check that fails is `mismatch`; one that
cannot be made now (a part cannot be read, the blockchain cannot be reached) is `unavailable`,
never `current`.

Each check is logged (`extract checked`) with its state and the extract's id, and for
`unavailable` or `mismatch` which part was the cause (`register`, `land-records`, `audit`); never
personal data. The request logs, here and in the gateway, show the path with `<token>` in place of
the token, and the gateway's proxy lines for the public route are off: whoever holds the token can
check the extract. There is no search: the token or the check code is the only way in.

## Events

Both events carry `extractId`, `extractNo`, `recordId`, `recordNo` and `versionNumber` (issued: also
`issuedFor: { name }` and `pdfSha256`; revoked: `reason`), never the token or the ID number. The audit service reads
them like every durable event, so they are in the land record's trail.

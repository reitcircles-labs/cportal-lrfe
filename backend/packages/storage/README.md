# @lrfe/storage

Shared file storage for the backend services: the stores (S3, local folder, memory), the streaming
SHA-256, and signed file links. This README also describes **how stored files are encrypted with
OpenBao** (epic API-633): the options investigated, the questions asked and the decisions taken.

*Design written 4 October 2026 (API-634), before the implementation (API-635 to API-640); updated
at the end of the epic if the implementation changes anything.*

## 1. The storage interface today

Every store has the same four functions:

| Function | Does |
|---|---|
| `put({ key, body, contentType })` | Writes a file (Buffer or stream) and returns `{ sha256, size }`, computed while it is written |
| `getStream(key)` | Reads a file as a stream |
| `delete(key)` | Removes a file (used to clean up after a failed filing or capture) |
| `signedUrl(key, { expiresIn, fileName, contentType })` | A direct download link (S3 presigned URL), or `null` |

| Store | Setting | Notes |
|---|---|---|
| `createS3Store` | `EDRMS_STORAGE=s3` | AWS S3 with S3-managed encryption (`AES256`); direct presigned links |
| `createLocalStore` | `…_STORAGE=local` | A folder; refuses to overwrite a file; no direct links |
| `createMemoryStore` | `…_STORAGE=memory` | Tests and the e2e stack |

`storageKey(prefix, id, version, fileName)` gives every version its own key, so files are never
replaced. `createLinkSigner` makes short-lived HMAC-signed links for stores without direct links:
the services then stream the file through their own route (edrms: `/content/:id/:n`).

**Who uses it:**
- **edrms** keeps the records (filed documents and replacement scans). Filing and corrections
  `put`; the viewer (`openContent`) and **Check integrity** (`verifyVersion`) `getStream`.
- **intake** keeps scans waiting for review. Capture `put`s and counts pages; the AI reader, the
  viewer and filing `getStream`.

## 2. The options investigated

The question: files stored locally (a folder or self-hosted object storage), encrypted and
decrypted with keys protected by OpenBao.

| | A. Whole file through OpenBao | **B. Envelope encryption (chosen)** | B1. + a key per records series | C. Storage encrypts, keys from OpenBao | D. Disk encryption |
|---|---|---|---|---|---|
| How | The service sends every file to `transit/encrypt` / `transit/decrypt` | OpenBao wraps a per-file data key; the service encrypts the file | B, with one OpenBao key per retention class | The storage system (e.g. Ceph) encrypts, asking OpenBao for keys | LUKS on the disks |
| OpenBao or storage sees plain files | OpenBao: yes | **no** | no | storage: yes | a running server: yes |
| Large files, streaming | no (request size limit, base64) | **yes** | yes | yes | yes |
| Load on OpenBao | every byte | **one small call per file** | same | per object | none |
| Key rotation | re-encrypt everything | **re-wrap keys only** | same | storage-dependent | re-encrypt the volume |
| Works with unchangeable (WORM) storage | yes | **yes** | yes, and destroys a series by deleting its key | yes | yes |
| Works with a local folder | yes | **yes** | yes | no | yes |
| Code in our services | small | **medium** | + key per class | none | none |

**Verdict:** B now; B1 later (once retention schedules are approved); D underneath as a baseline;
C only as an extra if Ceph is chosen. A is only for small values, never files.

## 3. KEK, DEK and wrapped key

| Term | What it is | How many | Where it lives |
|---|---|---|---|
| **KEK** (key-encryption key) | An OpenBao transit key, e.g. `edrms-files` | **One per service** (`edrms-files`, `intake-files`), with versions as it is rotated | **Inside OpenBao only**; it never leaves |
| **DEK** (data-encryption key) | A random 256-bit key that encrypts **one file** | **One per stored file** (every version, every scan) | Plain only in the service's memory, for one request; never on disk, in logs or the database |
| **Wrapped key** (wrapped DEK) | **The same DEK, encrypted with the KEK.** Not a third kind of key | One per DEK, so **one per file** | In the database, on the file's row |

The wrapped value looks like `vault:v1:8f2K…` (OpenBao keeps Vault's format): `v1` is the KEK
version that wrapped it, the rest is the DEK encrypted with its nonce and authentication tag. About
90 characters, useless without OpenBao.

*Analogy: the KEK is the bank's master key that never leaves the vault; each deposit box (file)
has its own key (DEK); that key is sealed in an envelope only the bank can open (the wrapped key),
kept with the box's paperwork (the database row).*

### Storing a file

```
service                                         OpenBao
1. POST transit/datakey/plaintext/edrms-files ─►  2. generates a random 256-bit DEK
                                                  3. encrypts it with the current KEK version
                                              ◄─  4. returns { plaintext: DEK, ciphertext: "vault:v1:…" }
5. stream the file → SHA-256 of the plain file → chunked AES-256-GCM with the DEK → store
6. database: the file's row + wrapped DEK + KEK name + ciphertext SHA-256
7. erase the plain DEK from memory
```

### Viewing a file

```
service: wrapped DEK from the database ─► POST transit/decrypt/edrms-files { ciphertext: "vault:v1:…" }
OpenBao: unwraps it with KEK version 1, inside the vault ─► returns only the DEK
service: stream from the store → decrypt chunk by chunk → browser (signed /content link, TLS) → erase the DEK
```

The service **never receives the KEK**: it sends the wrapped DEK and gets the DEK back.

### Rotation

`transit/keys/<kek>/rotate` adds a KEK version; new files are wrapped with it; older wrapped keys
still unwrap. `transit/rewrap` turns `vault:v1:…` into `vault:v2:…` (the same DEK, wrapped with the
newer KEK) inside OpenBao: files do not change, only database rows. A key-admin role does this; it
may rotate and re-wrap but not decrypt, so it never sees a DEK.

## 4. How OpenBao knows which service is calling

Files never reach OpenBao: only "give me a data key" and "unwrap this key". OpenBao identifies the
caller by the **token** sent with every request:

1. **Login.** Each service has its own **AppRole** (a role ID, like a username, and a secret ID,
   like a password, delivered separately). `POST auth/approle/login` returns a short-lived,
   renewable token tied to the role's policy.
2. **Every request** carries the token (`X-Vault-Token`). The key name is in the path; whether the
   service may use it is decided by the **policy** attached to the token:
   ```hcl
   # policy "edrms-files"
   path "transit/datakey/plaintext/edrms-files" { capabilities = ["update"] }
   path "transit/decrypt/edrms-files"           { capabilities = ["update"] }
   ```
3. **Another service's key is refused** (403), and the attempt is logged: intake cannot unwrap an
   edrms file's DEK, even with database access.
4. **The audit log** records every request: who (role), from where, which path, when, allowed or
   denied. Contents are HMAC-hashed, so data keys never appear in it.

Production adds: logins and tokens bound to the service's address (`secret_id_bound_cidrs`,
`token_bound_cidrs`), the secret ID delivered as a file only the service's user can read (or a
one-time wrapped token) and rotated, tokens valid for about an hour.

**AppRole and KEK are linked by the policy, not one-to-one by nature:**

```
service ──1:1──► AppRole ──► policy ──► KEK(s) it may use, and for what
edrms             edrms       edrms-files   edrms-files: datakey, decrypt
intake            intake      intake-files  intake-files: datakey, decrypt
```

| Case | AppRoles | KEKs |
|---|---|---|
| This epic | one per service | one per service |
| Later: a KEK per records series | still one for edrms | many (`edrms-files-2026-10y`, …); the policy allows `edrms-files-*` |
| Rotation job | its own (`key-admin`) | rotate and rewrap on all KEKs, no decrypt |
| Two services sharing a KEK | | possible, but avoided: each could open the other's files |

## 5. The document lifecycle, by service

| # | Step | Service(s) | File | KEK |
|---|---|---|---|---|
| 1 | Upload (Capture) | intake | intake's store | `intake-files` |
| 2 | AI reading | intake (reader); asks edrms about references | intake's store, read | `intake-files` |
| 3 | Review (Verify) | intake; asks edrms for duplicate and prior-title checks | intake's store, read | `intake-files` |
| 4 | **Filing** | **intake → edrms** (service token) | edrms's store (intake keeps its staged copy today) | intake decrypts with `intake-files`, sends the plain file over TLS; edrms encrypts with a new DEK under `edrms-files` |
| 5 | Viewing, search (Documents) | edrms | edrms's store, read | `edrms-files` |
| 6 | Integrity check | edrms | edrms's store, read | `edrms-files` |
| 7 | Correction | bpm (four-eyes process) → edrms | edrms's store; a file only for a replacement scan | `edrms-files` |
| 8 | Land record | frontend demo, looks up edrms; a service later | none | none |
| 9 | Audit | frontend demo + edrms integrity; an audit service later | edrms's store, read | `edrms-files` |
| 10 | Retention, destruction | not built yet | edrms's store | `edrms-files` (series keys later) |

The gateway carries every request and identity issues the tokens each service checks; events go
over NATS. **Only intake and edrms touch file content**, so only they get an AppRole and a KEK.
bpm, gateway and identity need none (their own secrets may move into OpenBao's key-value store
later).

## 6. The questions asked, and the decisions

| Question | Options | **Decision** | Why |
|---|---|---|---|
| Where encryption plugs in | a wrapper around the store, or code in each service | **A wrapper: `createEncryptingStore(store, keyring)` in this package** | Same interface; edrms and intake switch it on by setting; one implementation to test |
| Where the wrapped DEK is kept | database / a header in each file / both | **Database**, on the file's row (edrms version, intake document), with the KEK name and version | Rotation updates rows only; a file header could not be rewritten on unchangeable (WORM) storage |
| Encryption format | chunked AES-256-GCM / libsodium `secretstream` (XChaCha20-Poly1305) | **Chunked AES-256-GCM** (Node's built-in crypto) | FIPS-approved algorithm, often required in government procurement; no new dependency. The chunk format is ours, so it is tested against reordering, truncation and changed bytes |
| How services log in | a fixed token / AppRole | **AppRole**, one role per service | Short-lived renewable tokens; each service limited to its own KEK; logins can be bound to the service's address |

**Consequences of the wrapper:**
- `put` returns, besides `{ sha256, size }` of the **plain** file, an `encryption` record: algorithm,
  KEK name, wrapped DEK, chunk size, ciphertext SHA-256 and size. The services store it on the row
  and pass it back to `getStream`.
- **The seal does not change** (it covers the plain file's SHA-256); **Check integrity** keeps
  working through `getStream`. The ciphertext SHA-256 lets a future integrity sweep check storage
  without decrypting.
- **Tampering fails on read**: AES-GCM is authenticated, per chunk.
- **No direct S3 links** when encrypted (they would hand the browser ciphertext): `signedUrl`
  returns `null`, and the signed `/content` route streams the decrypted file.
- Files stored without an `encryption` record are read as they are (development data keeps
  working); production starts encrypted.
- A sealed or unreachable vault fails safe: filing, capture and viewing answer "document store
  temporarily unavailable" (neutral, no tool names on screen); the intake reader retries later.

**Chunk format (to be built in API-635):** a small header (magic, format version, chunk size, nonce
prefix; no key material), then chunks of e.g. 64 KiB, each AES-256-GCM with its own nonce, the
chunk number and a last-chunk marker in the authenticated data.

## 7. Seeing the state of the vault

OpenBao has a web UI at `/ui` (inherited from Vault), switched on with `ui = true` in its
configuration; `backend/scripts/bao.js` does not switch it on today. It shows seal status, the
Raft nodes, the transit keys and their versions, auth methods, policies, identities and leases,
limited to what the signed-in administrator's policy allows. AppRole roles are only partly shown;
the command line is complete:

```bash
bao status                          # sealed?, version, storage
bao auth list                       # login methods
bao list auth/approle/role          # AppRoles (edrms, intake)
bao policy list                     # policies
bao read transit/keys/edrms-files   # a KEK: versions, type, exportable?
bao operator raft list-peers        # Raft nodes
bao audit list                      # audit logging
```

Installing and running OpenBao: `backend/scripts/README.md` → "OpenBao: installation rules".

## 8. Later, and open points

- **A KEK per records series** (B1), once the National Archives-approved retention schedules exist.
- **Caching data keys briefly for the viewer**, so paging through a long deed does not call
  OpenBao each time.
- **Deleting intake's staged copy after filing or rejection**, so only the protected record remains.
- The broader storage recommendations (self-hosted object storage with Object Lock, signed seals,
  trusted timestamps, integrity sweeps, retention): `backend/docs/storage_integrations.md`.

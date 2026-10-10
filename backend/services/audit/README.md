# audit service (design)

*Design for the audit epic (API-652), written in API-653 (10 October 2026). The service itself is
built in API-654 to API-661; this document is what they build. The trail (§1) is built in API-654,
the tree (§2) in API-655.*

Auditors must be able to prove, **without trusting the portal**, that every land record version,
every filed document version and the audit trail itself are exactly as they were when recorded,
and to sign off records or raise findings on live data. The audit service:

1. keeps an **audit trail**: one entry per domain event, hash-chained, append-only;
2. keeps a **growing Merkle tree** (Merkle mountain range) over the seals of every land record
   version, every EDRMS document version and periodic checkpoints of the trail;
3. **anchors** the tree's root on **Cardano** once an hour (when something changed);
4. hands out **proofs** that anyone can check against the chain, also with an offline verifier;
5. records **sign-offs and findings**, and exports **evidence packs**.

Port 3506 (in the e2e stack: the next free offset after land-records), own schema `audit`,
`/api/audit` through the gateway.

## 1. The audit trail

**Source.** Every durable domain event (API-613), read with one durable consumer for all types:
`events.consume('>', handler, { durable: 'audit-trail' })` (the filter becomes `lrfe.>`). With the
memory and log drivers, used in tests, `consume` is a plain subscribe; API-654 makes `'>'` mean
every type there (`subscribe('*')`). Broadcast-only events
(`lrfe-live.>`: the session revocation, and the audit service's own anchoring events, §3) are not
in the stream and not in the trail. The consumer is the only writer; an event is acknowledged
after its entry is committed, so a crash re-delivers it, and the entry's unique `eventId` makes the
second delivery a no-op.

**Gaps.** The stream keeps events for `EVENT_STREAM_MAX_AGE_DAYS` (30). If the audit service were
down longer than that, the oldest missed events would be gone from the stream before it read them.
On start, and hourly, the service compares the stream's first sequence number with the last one its
consumer acknowledged (`events.consumerGap`, API-657); a gap is reported loudly (`audit.trail.gap`, log error) and recorded once as a
trail entry stating the missing range, so the loss is visible and cannot be passed off as complete.
When the audit service is added to a system that has run for longer than the stream keeps events, the first check records the events it never saw as one gap; that is correct, and the backfill (API-669) covers the seals from that time. That entry is written by the audit service itself (type `audit.trail.gap`, `eventId` derived from
the range, so it is never written twice), not consumed from the stream; the broadcast of the same
name only tells listeners.

**Before deployment.** The consumer starts with events published after it is created. A one-time
backfill (API-669, before the first anchoring) reads the seals of every land record version and EDRMS document version that
already exists (from land-records and edrms, with a service token) and adds them as leaves, oldest
first, before the first anchoring; the trail records the backfill as one entry with the counts.

**Entry** (table `audit.trail_entry`): `seq` (gap-free, 1, 2, 3 …), `eventId` (unique), `type`,
`source` (service), `time` (the event's, as text exactly as published), `actor` (id, name),
`subjects` (what it is about, read from the event: `record:<id>`, `document:<id>`, `edrmsNo:<no>`,
`intake:<id>`, `process:<id>`, `user:<id>`; `src/subjects.js`), the event's `data`, `prevHash`,
`contentHash`, `hash`, and `recordedAt` (when the audit service wrote it; not hashed).

```
contentHash(entry n) = SHA-256( canonicalJson({ seq, eventId, type, source, time, actor, subjects, data }) )
hash(entry n)        = SHA-256( prevHash || contentHash )        (both 32 bytes)
prevHash(entry n)    = hash(entry n-1);  prevHash(entry 1) = 32 zero bytes
```

Splitting the content's hash from the chain lets a proof carry later entries as hashes only (§4):
it never has to include other records' data.

Changing, removing or reordering any entry breaks every hash after it; `GET /audit/trail/verify`
recomputes the chain and names the first entry that is changed, missing or out of place. Two things
the chain alone cannot show, and the anchoring (§3) does: removing the *newest* entries, and
rewriting every entry and hash from some point on. Once a checkpoint covering them is on chain,
neither goes unnoticed.

**Reading a trail.** `GET /audit/trail?subject=record:<id>` returns the record's own entries plus
the steps of what it is made of: its documents' capture, extraction and filing in intake, their
filing and amendments in edrms, and its review processes in bpm. The service follows the links
between subjects (record → document number → document → intake document, process), but never into
another record or a user, so a document shared by two records does not bring in the other record's
steps. `subject=document:<id>` works the same way and shows every record that used the document.
`subject=user:<id>` returns what the user did, and the events that name them by id (an invitation,
a version they submitted). Administrators' changes to a user (suspended, roles changed) name the
user only by name in identity's events today, so they appear under the administrator.

The order is the order the consumer receives events in (JetStream stream
order), which is the order they were published, not exactly the order of the database commits in
different services; each entry keeps the event's own `time`.

**Checkpoint.** Once per batch (§3) the trail's head (`seq`, `hash`) becomes a leaf of the tree, so
the anchored root also proves the trail up to that entry. Entries after the checkpoint are covered
by the next one.

## 2. The growing Merkle tree (Merkle mountain range)

One append-only tree over everything ever recorded. Its root changes with every leaf added, and
**the latest root alone proves every earlier leaf**: an old root is inside a new one (a consistency
proof shows it), so a missing or changed old item cannot be hidden by anchoring a new root.

**Leaves.** Each leaf is the hash of one recorded item, with a one-byte type so an item of one kind
can never be passed off as another:

| Type | Byte | Item | From the event |
|---|---|---|---|
| Land record version | `0x01` | its seal (land-records README §7) | `records.record.committed` (`seal`) |
| EDRMS document version | `0x02` | its seal (edrms) | `edrms.document.filed`, `edrms.document.amended` (`seal`) |
| Trail checkpoint | `0x03` | the trail head `hash` | the audit service itself, per batch |

Seals are 64 hex characters (`sha256Hex`); the leaf takes the hex-decoded 32 bytes.

```
leaf  = SHA-256( 0x00 || type || item )          (item: the 32-byte seal or hash)
node  = SHA-256( 0x01 || left || right )
```

The `0x00`/`0x01` prefixes keep a leaf from ever being mistaken for an inner node (the classic
second-preimage defence, as in RFC 9162).

**Structure.** Leaves are appended in arrival order (position 0, 1, 2 …). A Merkle mountain range
keeps a list of perfect binary trees ("peaks"), one per set bit of the leaf count: 11 leaves =
8 + 2 + 1 = three peaks. Appending merges equal-sized peaks. The **root** of a tree of `size` leaves:

```
root = SHA-256( 0x02 || size (8 bytes, big-endian) || peak_1 || peak_2 || … )   (peaks from the largest)
```

Including `size` in the root fixes how many leaves it covers.

**Proofs.**
- *Inclusion* (an item is in the tree of size n): the leaf's position, the sibling hashes from the
  leaf up to its peak, and the other peaks of size n. About log2(n) hashes: ~24 for 13 million
  leaves, about 800 bytes in binary or 1.6 KB as hex in a JSON proof.
- *Consistency* (the tree of size m is the start of the tree of size n): the peaks of size m and
  the hashes that turn them into the peaks of size n. Shows that nothing anchored before was
  changed or dropped.

**Storage** (schema `audit`): `tree_node`, every node by position (leaves and inner nodes; about 2
per leaf), and `tree_leaf`, one row per leaf with its `key` (`record-version:<id>:<n>`,
`document-version:<id>:<n>`, `trail-checkpoint:<seq>`), type, item and the event it came from. A key
is added once, so a redelivered event adds nothing. One writer at a time (an advisory lock); an
append reads only the current peaks. A proof is a handful of point lookups; nothing is held in memory.

Measured with 1,000,000 leaves (`npm run bench -w @lrfe/audit`, API-655, PostgreSQL 15 on the
development server, batches of 10,000):

| | PostgreSQL | memory |
|---|---|---|
| Build | 128 s (7,800 leaves/s) | 18 s |
| Inclusion proof, made and checked | 2.7 ms, 19 hashes | 0.13 ms |
| Consistency proof 333,333 → 1,000,000 | 2.4 ms, 81 hashes | |
| Storage | 451 MB: `tree_node` 146 MB + 43 MB index, `tree_leaf` 166 MB + 95 MB index (472 bytes per leaf) | 1 GB heap |

For 13 million leaves that is about 6 GB, and a first backfill of that size about half an hour.

## 3. Anchoring on Cardano

**Batches.** Every `ANCHOR_PERIOD` (default 1 hour), if anything was recorded since the last
anchoring (new leaves, or trail entries after the last checkpoint): add a trail checkpoint (the
current head), compute the root and submit one transaction. So a sign-off, a finding or an export,
which add trail entries but no seal, are in the next hour's root. Nothing recorded: no transaction.

The audit service's own bookkeeping (`audit.root.anchored`, `audit.root.confirmed`,
`audit.wallet.low`, `audit.trail.gap`) is published **broadcast-only** (`durable: false`) and kept in
its own `anchor` table, not in the trail: otherwise each anchoring would add a trail entry and cause
the next one, every hour, for ever. Sign-offs, findings and exports are ordinary durable events and
do go into the trail.

**The transaction.** One input and one change output (the anchoring wallet's own address), no
smart contract, with the root in the transaction metadata under label **8890** (free in the CIP-10
registry on 10 October 2026; registering it there is optional and done before mainnet):

```json
{ "8890": { "v": 1, "sys": "lrfe-audit", "root": "<64 hex>", "size": 12345678, "batch": 87600, "prev": "<64 hex: previous root>" } }
```

Metadata strings are at most 64 bytes, so the root goes as 64 hex characters. `prev` links each
anchoring to the one before, so the anchorings themselves form a chain on the chain. `batch` numbers
the job's anchorings, including those given up (they never reached the chain), so the numbers on
chain can have gaps: a checker follows `prev`, not the numbering.

**Measured** (built with the real library, priced with the current parameters, which are the same on
preview and mainnet: 44 lovelace per byte + 155,381): **427 bytes, fee 174,169 lovelace
(0.174 ADA)**; with only `root` and `size`, 330 bytes and 0.170 ADA. The fee does not depend on how
many items the tree holds. On preview (API-656/657): 342 bytes and 0.170 ADA for the first anchoring,
413 bytes and 0.174 ADA with `prev`. The validity limit added in API-657 (below) adds about 5 bytes,
about 0.0002 ADA.

| Period | Transactions a year (at most) | ADA a year | USD at $0.235/ADA |
|---|---|---|---|
| hourly (default) | 8,760 | 1,526 | ~$359 |
| 15 minutes | 35,040 | 6,103 | ~$1,434 |
| daily | 365 | 64 | ~$15 |

Quiet hours cost nothing, so real costs are lower. Fees are fixed in ADA: the dollar cost follows
the ADA price. The wallet also keeps a small balance (the change output must hold at least about
1 ADA); that is not spent.

### Following an anchoring until it is confirmed

The job (`src/anchor.service.js`) runs **every minute**. Each anchoring is a row in `audit.anchor`:
batch, root, size, previous root, the trail checkpoint it covers, the signed transaction and its id,
the slot from which it is **no longer valid** (`ttl`), the wallet output it spends, fee, size in
bytes, block heights, status, number of sends, the first and last send time, and the last error. Only **one anchoring is in flight** at a time: the
next one spends this one's change output, so it waits until this one is confirmed or given up.
Only **one instance** runs the job: a lease in `audit.job_lease` (5 minutes, renewed every round, on
the database's clock), so a second instance of the audit service does nothing until the first stops.

```
                   send ok                 on chain                 10 blocks deep
   prepared ───────────────▶ submitted ───────────────▶ onChain ───────────────────▶ confirmed
      │  ▲                    │   ▲                       │
      │  └─ send failed:      │   └─ not on chain yet:    └─ gone (rollback): sent again ─▶ submitted
      │     sent again next   │      sent again every
      │     round             │      5 minutes
      │                       └─ past its limit, 10 more blocks, not on chain ─▶ failed (anchored again,
      │                                                                                 same output)
      └─ first send refused outright ─────────────────────────────────────▶ failed  (anchored again
                                                                                     after 5 minutes)
```

**The rules that make a double anchoring impossible.**

1. **Every anchoring transaction is valid for one hour.** It carries Cardano's validity limit
   (`ttl`, *invalid hereafter*): the chain's current slot + 3,600, a slot being one second on preview
   and mainnet. It is valid only in slots *before* that one; from that slot on, no node accepts it
   and no block can include it.
2. **The job never gives up on a transaction while it could still land.** Until the limit, it keeps
   the anchoring in flight and keeps sending the **same signed transaction** (stored, and the send
   recorded, *before* it goes out). Sending the same transaction twice is harmless: it has one id
   and spends one output, so it is included at most once.
3. **Past the limit, it waits until that is certain.** When the chain is first seen past the limit
   without the transaction, the job notes the block height and waits until the chain is another
   `ANCHOR_CONFIRMATIONS` blocks further (the same depth as a confirmation) before giving up. A
   provider's backends can lag behind each other, and a short fork could still hold the transaction
   in a block from before its limit.
4. **The replacement spends the same wallet output.** The new anchoring of the same leaves spends
   exactly the output the given-up one spent, even if the wallet holds larger ones (after a top-up).
   Two transactions spending the same output can never both be on chain. If that output turns out to
   be spent, the job checks **every** given-up anchoring that spent it (a refused replacement spent
   it too) and follows the one that is on chain again, instead of building another. Only if none is
   on chain, also after waiting `ANCHOR_CONFIRMATIONS` blocks, does it conclude that something else
   spent the wallet's output, report it, and use another output.

Why this matters: a provider can time out *after* the node accepted the transaction. The transaction
then waits in the node's mempool, not yet in a block. A second send of it is refused (its input is
already spent in the mempool), and neither Ogmios nor Blockfrost shows mempool transactions as on
chain. Without the time limit there was no way to tell "refused because it is already waiting" from
"refused for good", and giving up could have anchored the same leaves twice once both landed. The
same could happen after a crash between the send and recording it, which is why the send is recorded
first (both found in the API-657 reviews).

**Timers and limits**

| What | Value | Setting | Where |
|---|---|---|---|
| A round of the job | every minute | | `checkMs` |
| Time between anchorings | 1 hour | `ANCHOR_PERIOD` (`1h`, `15m`, `90s`; at least a minute) | `periodMs` |
| A transaction is valid for | 3,600 slots (1 hour) | | `ttlSlots` (adapter) |
| Before giving up an expired one | another 10 blocks (as `ANCHOR_CONFIRMATIONS`) | | `confirmations` |
| Sending again while not on chain | every 5 minutes | | `resendMs` |
| Waiting after a first send refused outright | 5 minutes | | `retryMs` |
| Confirmed at | 10 blocks deep (preview, ~3–7 minutes); 30 on mainnet (~10 minutes) | `ANCHOR_CONFIRMATIONS` | `confirmations` |
| Calls to Ogmios or Blockfrost time out after | 10 seconds | | drivers |
| Calls to OpenBao time out after | 5 seconds | | signer |
| The job's lease | 5 minutes, renewed every round | | `claimLease` |
| Low-balance warning below | 5 ADA | `ANCHOR_MIN_BALANCE_ADA` | adapter |

**What happens when …**

| Situation | What the job does | Result |
|---|---|---|
| Nothing recorded since the last anchoring | nothing | no transaction, no cost |
| Provider or node unreachable, OpenBao unreachable, node still syncing | logs a warning, tries again next round | anchoring delayed, nothing lost |
| The send times out (reply lost) | sends the same transaction again next round | one anchoring |
| The repeat is refused because the node already has it | keeps it in flight (`submitted`), follows it | lands once; or expires and is anchored again |
| Accepted, then forgotten by the mempool (node restart) | sends it again every 5 minutes | lands once |
| On chain, then rolled back | sends the same transaction again at once | lands once |
| Past its limit and still not on chain 10 blocks later | marks it `failed`, builds a new anchoring of the same leaves in the same round, spending the same wallet output | the new root covers everything; never both on chain |
| A given-up one turns out to be on chain (a fork), even after its replacement was refused | follows it again; the others that spent its output are done with; the next anchoring comes a period after it | one anchoring |
| The output a given-up one spent was spent by something else (a shared wallet) | waits 10 blocks to be sure, logs an error, then uses another output | anchored, with an error to look into |
| Refused on its very first send (e.g. a build error) | marks it `failed`, tries a new one after 5 minutes | no error flood |
| The wallet cannot pay | logs an error, warns about the balance (`audit.wallet.low`) | anchored once funded |
| The audit service restarts mid-way, even right after a send | the row, the signed transaction and the send are in the database: it carries on, and a refusal of the repeat keeps it in flight | one anchoring |
| It stops between recording a send and making it | the transaction was never sent; it is sent at the next round (or, if that fails, waits out its hour and is replaced) | one anchoring, at worst an hour late |

**Depth.** Once the transaction's output is on chain, its depth is counted from its block (Blockfrost
knows it) or from the block height at which the job **first saw** it (Ogmios: a state query does not
give the inclusion block, so this can only under-count). At `ANCHOR_CONFIRMATIONS` blocks it is
*confirmed*, and the leaves it covers can be proven against it. Ogmios checks "on chain" by asking
whether the transaction's output is unspent; that is right for the one anchoring in flight, which
nothing else spends.

**One wallet per installation.** Two installations sharing a wallet compete for the same outputs:
one side's transactions are refused, and with Ogmios one could take the other's change output for a
rollback. Each installation (development, test, production) gets its own `audit-anchor` key, which
`npm run bao -- --dev` creates per OpenBao.

**Events** (broadcast-only): `audit.root.anchored` at the first successful send, `audit.root.confirmed`,
`audit.wallet.low`. The log says `root anchored`, `anchoring confirmed`, and a warning or error for
each case above.

**The anchoring wallet.** One Ed25519 payment key, created and kept in **OpenBao's transit engine**
(key `audit-anchor`, type `ed25519`, not exportable). The audit service never sees the private key:
it builds the transaction body, asks OpenBao to sign the body's 32-byte hash (`transit/sign`), and
adds the returned signature as the key witness. Checked on 10 October 2026 with OpenBao 2.7.1: a
transit ed25519 signature over a 32-byte hash is a plain 64-byte Ed25519 signature. The wallet's
address is an enterprise address of the key's public key (`transit/keys/audit-anchor`). The audit
service's AppRole may only `sign` with that key and read its public key. A low-balance warning
(`ANCHOR_MIN_BALANCE_ADA`) goes to the log and as an event; preview is funded from the faucet.

**Chain access: one adapter, two drivers** (`CARDANO_PROVIDER`):

| Operation | `ogmios` (own node, API-662) | `blockfrost` |
|---|---|---|
| protocol parameters | `queryLedgerState/protocolParameters` | `GET /epochs/latest/parameters` |
| the wallet's unspent outputs | `queryLedgerState/utxo` (by address) | `GET /addresses/{address}/utxos` |
| submit | `submitTransaction` | `POST /tx/submit` |
| the current slot (for the validity limit) | `queryNetwork/tip` | `GET /blocks/latest` (`slot`) |
| is the output on chain, how deep | `queryLedgerState/utxo` (by output reference) + `queryNetwork/blockHeight` | `GET /txs/{hash}` (block height) + `GET /blocks/latest` |

Ogmios listens on `127.0.0.1` only (API-662). The Blockfrost project key is a secret (OpenBao or a
file only the service's user can read), never shown on screen. `CARDANO_NETWORK` is `preview` in
this epic; `mainnet` later.

**Library.** `@emurgo/cardano-serialization-lib-nodejs` (maintained, Cardano's reference
serialization library) to build and serialize the transaction; signing through OpenBao as above.
No higher-level framework: both drivers need only the four operations above.

## 4. Proofs and verification

**A proof** (JSON, `GET /audit/proofs/{kind}/{id}`) for a land record version, a document version or
a trail entry:

```json
{ "item": { "kind": "record-version", "recordNo": "LR-NA-2026-000001", "version": 2, "seal": "…" },
  "leaf": { "type": 1, "position": 41237, "hash": "…" },
  "tree": { "size": 41300, "path": ["…"], "peaks": ["…"], "root": "…" },
  "anchor": { "network": "preview", "label": 8890, "tx": "…", "block": 1234567, "blockIs": "included | firstSeen", "confirmations": 42, "status": "confirmed" } }
```

A trail entry's proof adds the chain from it to the next checkpoint: the entry itself, and for each
later entry up to the checkpoint only its `contentHash` (§1), so the checker can recompute the
chain to the checkpoint leaf without seeing other records' data. "The entry itself" includes its
`prevHash`, which starts the recomputation.

**Verify** (`POST /audit/verify`): recompute the item's seal from the current data (land-records,
edrms), check the leaf, the path to the root, and that the root is in that transaction's metadata.

**The offline verifier** (`npx @lrfe/verify proof.json`, or one standalone file): checks a proof
without the portal, reading the transaction's metadata from any public source (Blockfrost, Koios'
free API, or an explorer). An evidence pack (§6) contains everything it needs.

Until its batch is anchored, an item's proof status is *waiting for the next anchoring*; the land
record's History tab and the Audit screen show it.

## 5. Sign-off and findings

- **Sign-off** (`audit.signoff`): mark a land record version (or a document version in it) audited,
  with a comment. A sign-off is itself a domain event, so it is in the trail and in the next root.
- **Finding** (`audit.signoff`): a description on a record or document version; the records officer
  and the registrar get a task (bpm). Open until resolved by a newer reviewed version, or closed by
  the auditor with a reason.
- **Segregation of duties (sod2):** whoever approved a land record version cannot sign it off; the
  service refuses ("You approved this version: another auditor must sign it off") and the screen
  shows why. The approver is in `records.record.committed` (`approvedBy`). This per-version rule is
  always applied. The catalogue's duty rule sod2 (`record.finalize` and `audit.signoff` held by one
  person, Administration → Security policies) is the separate, role-level warning when roles are
  assigned; switching that rule off does not lift the per-version refusal.

## 6. Evidence pack

`GET /audit/records/{id}/evidence` (`audit.export`): one zip with every committed version (JSON)
and seal, the documents it pins (files and verified metadata) and their seals, the record's trail
entries, sign-offs and findings, a proof for each version and document, a readable summary and
instructions for the offline verifier. Exporting is itself an event in the trail.

## 7. Privacy

Only hashes go on chain: the root, the tree size, a batch number and the previous root. No names,
ID numbers, parcel or document content, not even an individual seal. Nothing on chain can be
traced back to a person without the portal's data, and the portal's data cannot be changed without
the chain showing it.

## 8. API, events, permissions

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /audit/trail?subject=&type=&from=&to=` | `audit.view` | trail entries |
| `GET /audit/trail/verify` | `audit.view` | recompute the trail's chain |
| `GET /audit/proofs/{kind}/{id}` | `audit.view` | the proof of an item |
| `POST /audit/verify` | `audit.view` | verify an item against the chain |
| `GET /audit/anchors` | `audit.view` | anchorings, their transactions and status |
| `POST /audit/signoffs` · `POST /audit/findings` · `…/findings/{id}/close` | `audit.signoff` | sign off, raise or close a finding |
| `GET /audit/records/{id}/evidence` | `audit.export` | evidence pack |

Events, durable (in the trail): `audit.signoff.recorded`, `audit.finding.raised`,
`audit.finding.closed`, `audit.evidence.exported`. Broadcast-only (§3; not in the trail):
`audit.root.anchored`, `audit.root.confirmed`, `audit.wallet.low`, `audit.trail.gap`. The permissions are
already in the identity catalogue.

## 9. Mainnet (not in this epic)

- `CARDANO_NETWORK=mainnet`, a mainnet address (the same transit key gives a mainnet address with
  the mainnet network id), funded with real ADA; `ANCHOR_CONFIRMATIONS` 30 or more.
- **Own node:** a mainnet `cardano-node` needs about 24 GB of RAM (in-memory ledger; about 8 GB with
  the on-disk ledger) and 300 GB or more of disk, growing (Cardano developer docs, 2026). Ogmios
  on top is light.
- **Blockfrost:** the free plan (50,000 requests a day) covers hourly anchoring and checks; paid
  plans exist for heavy verification traffic. Check the current plans before going live.
- Register label 8890 in CIP-10.

## 10. Settings

`ANCHOR_PERIOD` (1h), `ANCHOR_CONFIRMATIONS` (10), `ANCHOR_MIN_BALANCE_ADA` (5), `CARDANO_NETWORK`
(preview), `CARDANO_PROVIDER` (ogmios | blockfrost), `OGMIOS_URL` (http://127.0.0.1:1337),
`BLOCKFROST_PROJECT_ID_FILE`, `ANCHOR_BAO_KEY` (audit-anchor), plus the usual `AUDIT_STORE`,
`DB_CONNECTION_STRING`, `DB_SYNC`, `JWT_SECRET`, OpenBao AppRole settings.

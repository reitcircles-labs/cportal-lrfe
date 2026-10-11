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
**backfill** (API-669) reads the seals of every committed land record version and every EDRMS
document version that already exists, from land-records (`GET /records/seals`) and edrms
(`GET /documents/seals`): service-only endpoints for the audit service's service token, oldest
first, paged with a cursor (the position of the last seal read) over an index in each service, so
the last page of 13 million is as quick as the first. It merges the two lists by time and adds them as leaves with the same keys live events
give them (`record-version:<id>:<n>`, `document-version:<id>:<n>`), so nothing is added twice: not
when it runs again, nor for seals whose events also arrived. Each run that adds leaves is one trail
entry (`audit.backfill.completed`, with the counts and the leaf range). It runs **by itself before
the first anchoring** when the tree is empty and anchoring is on (retried every minute while
land-records or edrms cannot be reached; anchoring waits for it), and by hand with
`npm run audit:backfill`, which is safe to repeat (for an installation whose tree already has
leaves, such as one where the audit service started after other data existed). Seals whose events
arrive during a backfill are added as they come, so they sit between the backfilled ones: the
tree's order is then the order in which the audit service learned of each seal, which proofs do not
depend on.

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

API-658. `src/proof.service.js`, the routes in `src/routes.js`, the offline verifier in
`verifier/lrfe-verify.mjs`.

**A proof** (`GET /audit/proofs/{kind}/{id}`, `audit.view`) shows that an item is a leaf of the tree
whose root went on Cardano in one transaction. `kind` is `record-version` or `document-version` (`id`
the land record or document id, `?version=` the version) or `trail-entry` (`id` its `seq`):

```json
{ "format": "lrfe-audit-proof/1",
  "status": "confirmed",
  "item": { "kind": "record-version", "recordId": "…", "version": 2, "seal": "…" },
  "leaf": { "key": "record-version:…:2", "type": 1, "item": "…", "index": 41237, "hash": "…" },
  "tree": { "size": 41300, "path": ["…"], "peaks": ["…"], "root": "…" },
  "anchor": { "network": "preview", "label": 8890, "batch": 812, "tx": "…", "root": "…", "size": 41300,
              "address": "addr_test1…", "block": 4744555, "blockIs": "included", "confirmations": 42,
              "status": "confirmed", "confirmedAt": "…" } }
```

- **Which anchoring.** The first one sent (submitted, on chain or confirmed; never a given-up one)
  whose tree covers the leaf (`size > index`), and the path is taken in the tree of that size, so the
  root in the proof is the root in that transaction. Later anchorings contain it too (consistency, §2);
  the first is the one that proves the item existed from then on.
- **`status`**: `waiting` while no anchoring covers the item (the proof is then against the tree as it
  is now, `anchor` is null, and it cannot be checked on chain yet), `anchored` while its anchoring is
  on its way (`anchor.status` `submitted` or `onChain`), `confirmed` once it is `ANCHOR_CONFIRMATIONS`
  deep.
- **`address`**: the anchoring wallet, which pays for every anchoring. Anyone can write a root into
  a transaction; only the portal can spend from its wallet, so the verifier checks the transaction was
  paid from it. The installation publishes the address (it is in the log at start, `audit: anchoring
  wallet`); a checker compares it, or pins it with `--address`.
- **`block` and `blockIs`.** With Blockfrost the block that holds the transaction (`included`); with
  the own node the height at which the job first saw it on chain (`firstSeen`: Ogmios does not say
  which block holds a transaction). `confirmations` is counted when the proof is made, from the chain's
  current height; left out (null) when the chain cannot be reached then.
- **A trail entry** is covered by the first trail checkpoint at or after it that went on chain (the
  anchoring's `checkpointSeq`). The proof adds `trail: { entry, later, checkpoint }`: the entry with all
  its hashed fields, `prevHash`, `contentHash` and `hash`; for each later entry up to the checkpoint
  only its `contentHash` (§1), so no other record's data is in the proof; and the checkpoint
  `{ seq, hash }`, which is the leaf's item. The checker recomputes the entry's hashes from its content,
  then `hash = SHA-256(prevHash || contentHash)` entry by entry up to the checkpoint. An entry recorded
  after the last anchored checkpoint is `waiting`, with no leaf or tree, until the next anchoring.

**Verify** (`POST /audit/verify { kind, id, version }`, `audit.view`) makes the proof and checks it
now, three checks, each with `ok` and, when it fails, a `problem`:

1. **`item`**: the seal recomputed from the current data by the service that owns it, which must be
   intact and equal to the seal in the tree. Land records: `GET /records/:id/verify` (the version's
   seal from its data and the seal chain). Documents: `GET /documents/:id/versions/:n/verify` (edrms
   reads the stored file again, hashes it and recomputes the seal from it and the metadata). Both
   routes accept the audit service's service token. A trail entry: its hashes recomputed from the
   stored entry, then the chain to the checkpoint.
2. **`path`**: the leaf hash recomputed from the type and item, and the path from it to the root.
3. **`chain`**: the root and size in the transaction's metadata (label 8890). With Blockfrost they
   are read from the chain (`source: "blockfrost"`): the transaction must be there and carry this
   root. The own node keeps no index of past transactions (§3), so with Ogmios the check is made on
   the signed transaction as it was sent and stored in `audit.anchor` (`source: "stored"`): its id is
   the hash of its body, the body holds the hash of its metadata, so that transaction id can only
   carry that root, and its signature must verify with the anchoring wallet's key (so a row rewritten
   in the database would need the key in OpenBao); that it is on chain is the anchoring job's record
   of it. The offline verifier
   checks the chain itself on a public source.

`valid` is true only when all three hold; an item that is still `waiting` is never valid. When the
owning service or the chain cannot be reached, that check's `ok` is null and `valid` false, and its
`problem` says why; verify is a check, not a cached result.

**The offline verifier** (`verifier/lrfe-verify.mjs`) checks a proof file with no access to the
portal: one file, Node 18 or later, nothing to install. It recomputes the leaf (for a trail entry,
the entry's hashes and the chain to the checkpoint), the path to the root, and reads the
transaction from a public source:

```bash
node lrfe-verify.mjs proof.json --address addr_test1…  # Koios: the public Cardano API, no key
node lrfe-verify.mjs proof.json --source blockfrost   # Blockfrost: key in BLOCKFROST_PROJECT_ID or --key-file
node lrfe-verify.mjs proof.json --json                # the result as JSON
npm run verify -w @lrfe/audit -- proof.json           # the same, from backend/
```

Last, it checks the transaction was **paid by the anchoring wallet** named in the proof (Koios
`tx_info` inputs, Blockfrost `/txs/{tx}/utxos`): without it, anyone could put a made-up tree's root
on chain from their own wallet. `--address <the installation's published address>` also requires
the proof's wallet to be that one; without it the verifier prints the wallet to compare. Always pass
it: a proof that names someone else's wallet is otherwise only caught by that comparison. The proof
names the wallet as it is now; if the `audit-anchor` key were ever replaced, proofs of earlier
anchorings would name the new wallet (the address would then have to be kept per anchoring).

It prints each check and VALID or NOT VALID; exit code 0 valid, 1 not valid, 2 could not be checked
(no proof file, the source unreachable). It also accepts the answer of `POST /audit/verify`, which
holds the proof. For a land record or document version it takes the seal, and the record or document
id and version it belongs to, from the proof and says so: recomputing the seal needs the version's
data, which the evidence pack (§6) adds. For a trail entry everything is recomputed, and the chain
must be exactly as long as from the entry to the checkpoint.

**The anchoring status next to each version.** land-records' History (`GET /records/:id/history`)
and edrms' documents (`GET /documents/:id`, for users) show each version's status: `waiting` for the
next anchoring, `anchored`, `confirmed` (with the batch and the transaction). They ask the audit
service (`POST /audit/anchoring { keys }`, for their service tokens only) with a 2-second limit; when
it is down or not installed the status is null and nothing else is held up (`AUDIT_URL` in their
settings). The land record's History tab and the document's version history show it as a tag.

**Tested** (`tests/proof.test.js`): valid proofs of a land record version, a document version and a
trail entry from the register of Erf 1873 committed through the review; a changed version, document
or trail entry, a wrong path, another tree's root, a transaction that is not on chain and a root put
on chain from another wallet all fail, in the service and in the offline verifier; the own-node check
on the stored transaction (a transaction signed by another key fails); the statuses from `waiting` to
`confirmed`; a prepared or refused anchoring is never used, its replacement is; the verifier's tree
arithmetic against the service's for every leaf of trees up to 70 leaves. Checked by hand for
API-658 (results in Jira): on PostgreSQL the proofs equal the memory store's, through a refused
anchoring and its replacement; on preview the offline verifier confirmed real proofs through Koios
and Blockfrost.

## 5. Sign-off and findings

API-659, API-680. `src/signoff.service.js`, the routes in `src/routes.js`, the bpm processes
`services/bpm/src/definitions/audit-finding.json` and `audit-rereview.json`.

**Who owns what.** The approver owns the land record: approving commits and seals the version (the
record's details, every document with its own seal, the previous version's seal), and the seal is
anchored. Auditors are external: they check, and never shape the record. Only what is on the
blockchain and matches it can be trusted, so nothing is audited before it is there.

**The audit sign-off is a checkpoint** (API-680). One sign-off covers every version of a land record
committed since its last audit sign-off (or since v1), and the document versions those versions
pinned that no earlier sign-off covered. The next audit starts after it. Documents have no sign-off
of their own: each is checked against the blockchain automatically; the auditor checks each version's
changes (do the documents belong to this erf, is anything missing, do the details follow from them).

`GET /audit/records/{id}/check` (`audit.view`) gives the open checkpoint: `range { from, to }`,
`lastSignoff`, each version and document with its `anchoring` (`waiting`, `sent`, `onChain`,
`confirmed`) and, once on the blockchain, its `match` (`matches`, `changed`, `unavailable`; before that
`notOnChain`), the open findings, and `canSignOff` with the `reason` when not, for the user asking.
A match is the proof check of section 4: the seal recomputed now by land-records or edrms, the path
to the anchored root, and the root in the transaction.

`POST /audit/signoffs { recordId, comment? }` (`audit.signoff`) checks it all again and stores one
sign-off: `kind: "checkpoint"`, `fromVersion`, `toVersion` (also `recordVersion`), the top version's
`seal`, and in `items` the version and document seals it covers and the ids of the findings in its
range. Refused, with the reason the screen shows as it is, in this order:

| Status | When | Reason |
|---|---|---|
| 409 | nothing committed since the last sign-off | Nothing to audit: no version was committed since the last audit sign-off (v[N]). |
| 403 `{ rule: "sod2" }` | the user holds `record.finalize` | You can commit land record versions, so you can't sign off audits. Another auditor signs off. |
| 403 `{ rule: "sod2" }` | the user approved a version in the range (its `approvedById`) | You approved v[N], which is part of this audit, so another auditor must sign it off. |
| 409 | an item is in no anchoring yet | Some items go to the blockchain with the next batch. You can sign off once everything is there. |
| 409 | an item's transaction is sent but not in a block (it can still fail) | [ITEM] is on its way to the blockchain. You can sign off once it is in a block, usually within minutes. |
| 409 | an item no longer matches the blockchain | The audit can't be signed off until the land record has been re-reviewed and submitted again. |
| 503 | the check could not run (the chain or the owning service unreachable) | The blockchain couldn't be reached. Try again in a few minutes. |
| 409 | a finding on the record or a covered document is open | The finding on [ITEM] is still open. … |

Open findings that block it: those on the land record, and those on a document version on its own
that this checkpoint covers. A finding on a document version covered by an earlier sign-off was part
of that audit.

One sign-off per checkpoint, whoever signs it, also for two requests at the same moment (unique
indexes on record and `toVersion`, and on record and `fromVersion`, so checkpoints never overlap). API-659's sign-offs of one item (`kind: "item"`) stay readable as
history. `GET /audit/signoffs?recordId=&documentId=` (`audit.view`).

The catalogue's duty rule sod2 (`record.finalize` and `audit.signoff` held by one person,
Administration → Security policies) is the role-level warning when roles are assigned; switching it
off does not lift these refusals.

**Changed since review.** An item that no longer matches is not a finding: the land record changed
since it was reviewed and submitted, so it cannot be audited as true. The first time it is found, the
audit service starts the bpm process `audit-rereview` (a task each for the records officers and the
registrars: "Re-review: changed since review, …") and records `audit.item.changed`; once per item
(`audit.changed_alert`, with the record's current version then). If bpm cannot be reached it is tried
again at the next check. The records office then opens a new draft, corrects what changed and submits
it; once a version committed after the change was found matches (and, for a changed document version,
no longer pins it), the changed item no longer blocks the sign-off and is kept in it as
`superseded`.

**Finding** (`POST /audit/findings { recordId, version, documentId?, description }` or
`{ documentId, version, description }`, `audit.signoff`): a description on a land record version, a
document version in it, or a document version on its own. The audit service first starts the bpm
process `audit-finding`, which gives the records officers (role `rec`) and the registrars (role `sup`)
a task each in their inbox: the finding, who raised it, the record or document, and "Acknowledge". If
bpm cannot be reached the finding is not raised (503): nobody would be told. A finding is raised on
the current version (an older one is already replaced by a reviewed version, or a document version
already corrected in edrms: 409); one raised while a newer version is being committed is resolved at
once.

A finding is a **thread**. Any auditor (`audit.signoff`), not only the one who raised it, may answer
it (`POST /audit/findings/{id}/answers { text }`): the answer is stored with who wrote it and when.
No other role answers or closes; the records desk reads findings and acknowledges its tasks. While a
finding is open the audit cannot be signed off. It ends in one of three ways:

- a **newer reviewed version resolves it**: a committed land record version (`records.record.committed`
  with a higher version number) for a finding on a record version, an approved correction
  (`edrms.document.amended` with a higher version) for a finding on a document version (status
  `resolved`, `resolvedByVersion`); the corrected version joins the next checkpoint, so it must be on
  the blockchain before that is signed off;
- an auditor closes it **resolved by agreement**: settled outside the portal, for example in a meeting
  (`POST /audit/findings/{id}/close { outcome: "agreed", answer }`), the agreed exception; or
- an auditor closes it **raised by mistake** (`outcome: "mistake"`).

Closing needs an answer: who agreed, when, what was decided. It is stored as the thread's last message
(`closeReason`, `closedByName`, `closedAt`, status `closed`, `outcome`). A close in API-659's form,
`{ reason }`, is read as `{ outcome: "mistake", answer: reason }`. A finding is never deleted. Either
way the bpm process is withdrawn if it is still open (best effort: if bpm cannot be reached the
finding is closed all the same and its tasks stay until acknowledged). `GET /audit/findings?recordId=&documentId=&status=`
and `GET /audit/findings/{id}` are for auditors and for the records desk (`audit.view` or
`record.view`).

**In the trail and on chain.** Sign-offs, findings and alerts are stored in `audit.signoff`,
`audit.finding` and `audit.changed_alert` and published as durable events in the same transaction (the
audit service's outbox): `audit.signoff.recorded`, `audit.finding.raised`, `audit.finding.answered`,
`audit.finding.closed` (`outcome` `resolved`, `agreed` or `mistake`), `audit.item.changed`. The audit
service's consumer records them like any other event, under the record's and the document's subjects
(`recordId`, `edrmsDocumentId`) and the process (`instanceId`), so a finding is in the audit trail of
the document and of the land record it is about, and the next anchoring covers it. Each finding event
carries the whole thread under the key `Findings`: who raised it and why, every answer (name, role,
time, text), and how it ended.

## 6. Evidence pack

API-660. `src/evidence.service.js` (with `src/zip.js`), the pack mode of `verifier/lrfe-verify.mjs`.

`GET /audit/records/{id}/evidence` (`audit.export`) returns one zip with everything needed to defend
a land record outside the portal:

| In the pack | What it is |
|---|---|
| `README.txt` | a readable summary (versions, documents, trail, sign-offs, findings, proofs) and how to check the pack |
| `manifest.json` | format `lrfe-evidence-pack/1`, the record, who exported it when, the anchoring network and wallet, every file's SHA-256 |
| `record/record.json`, `record/versions/v<n>.json` | the land record, and each committed version as sealed (land-records) |
| `documents/<edrmsNo>/v<n>.json`, `documents/<edrmsNo>/v<n>-<file>` | each document version pinned in those versions: its sealed metadata (edrms) and its file, read from the store through a service-only edrms route |
| `trail/entries.json` | the record's audit trail, with its documents' steps (§1) |
| `signoffs.json`, `findings.json` | sign-offs and findings (§5) |
| `proofs/record-v<n>.json`, `proofs/<edrmsNo>-v<n>.json`, `proofs/trail-<seq>.json` | a proof (§4) for each version, document version and trail entry |

The export is itself a trail entry (`audit.evidence.exported`: who, which record, how many files, and
the SHA-256 of `manifest.json`, also in the response header `x-manifest-sha256`), and so anchored with
the next root. A record without a committed version has nothing to export (409).

**Checking a pack** without the portal: `node lrfe-verify.mjs evidence-<recordNo>-<date>.zip --address
<published wallet>` (or the folder it was unpacked into). The verifier:

1. checks every file against `manifest.json`, that nothing was added or removed, and that every JSON
   file reads;
2. recomputes each committed version's seal from its JSON (as land-records does) and checks the chain
   of seals from the first version (whose previous seal is empty), so a changed, removed or inserted
   version in between is caught; checks `record.json`'s id and current version against them;
   requires every document version the versions pin, with the pinned seal and type, recomputes its
   seal (as edrms does) and its file's SHA-256; a document no version pins fails;
3. recomputes every trail entry's hashes, and compares sign-offs and findings with their trail
   entries both ways, field by field (item, comment or description, who, close reason, resolving
   version);
4. requires a proof file for every version, document version and trail entry (the export writes a
   placeholder for an item not in the audit tree), proving that very item, and checks it against the
   chain (§4), each transaction read once. Each version is also compared with its commit entry in the
   trail (`records.record.committed`: seal, previous seal) and each document version with its filing
   or correction entry (seal, SHA-256); a mismatch fails, and a commit in the trail whose version is
   not in the pack fails. An item without an anchored proof of its own is proven when an anchored item
   pins it: an anchored trail proof (the hashes of the later entries up to its checkpoint, and the
   entry before it), the commit or filing entry so proven, a later version (its previous seals), any
   version that pins it (every pin of a document version must agree). "Not yet anchored" must be
   believable: a version or document version older (by more than 10 minutes) than trail entries the
   pack shows anchored would be in that anchoring, so without a proof it fails (changed, or missing
   from the audit tree: run the backfill), and so does one that is neither proven nor bound to its
   commit or filing entry in the pack's trail. Still, whoever rewrites the pack can present the newest
   version, and what only it pins, as committed after the last anchoring (with a late date and a late,
   unanchored commit entry): an honest pack exported right after a commit looks the same. Unproven
   items are therefore only that: "VALID AS FAR AS ANCHORED" vouches for the anchored items; the rest is
   settled by the portal, or by exporting again after the next anchoring. A placeholder such a pin contradicts fails; items nothing pins are listed as not yet anchored
   ("VALID AS FAR AS ANCHORED"); exporting again after the next anchoring covers them.

A forger who changes a file and rewrites the manifest is therefore caught by the content, for every
item proven on chain (directly or through an anchored item that pins it). Not covered
by any seal, and listed by the verifier as shown as exported: `README.txt`, the manifest's exporter,
time and wallet, `record.json` beyond its id and current version, document titles, and the times of
sign-offs and findings. An offline check also cannot show that nothing was left out when the newest
version, or a trail entry, is removed together with its proof. The portal can: it recorded the export
with the SHA-256 of the manifest (`audit.evidence.exported`), anchored with the next root.

The export refuses a stored file that no longer matches the SHA-256 it was sealed with (409, naming the
document): check its integrity on the Documents screen first. The pack is built before the export is
recorded, so the trail never records an export that did not happen.

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
| `GET /audit/proofs/{kind}/{id}?version=` | `audit.view` | the proof of an item |
| `POST /audit/verify` | `audit.view` | verify an item against the chain |
| `POST /audit/anchoring` | land-records, edrms (service) | the anchoring status of versions |
| `GET /audit/anchors?status=` · `GET /audit/anchors/{batch}` · `…/{batch}/coverage` · `…/{batch}/documents` | `anchors.view` (every role) | the Anchorings screens (API-671): every batch, newest first, with what it covers, its transaction and explorer link, block and confirmations, and for a failed one why (`expired`, `rolledBackExpired`, `refused`) and the batch that replaced it; when the next batch is due; what a batch covers: by kind, each land record version with the documents it is made of (its seal stands for them and, through the previous seal, the versions before it), and the batch's documents (API-696, with land-records' `POST /records/lookup`) |
| `GET /audit/records?filter=&q=` | `audit.view` | the Audit screen's list: changed since the last audit, needing attention, or all |
| `GET /audit/records/{id}/check` | `audit.view` | the open checkpoint, checked against the blockchain |
| `POST /audit/signoffs` · `POST /audit/findings` · `…/findings/{id}/answers` · `…/findings/{id}/close` | `audit.signoff` | sign off a checkpoint; raise, answer or close a finding |
| `GET /audit/signoffs` | `audit.view` | sign-offs of a record or document |
| `GET /audit/findings` · `GET /audit/findings/{id}` | `audit.view` or `record.view` | findings (also for the records desk) |
| `GET /audit/records/{id}/evidence` | `audit.export` | evidence pack |

Events, durable (in the trail): `audit.signoff.recorded`, `audit.finding.raised`,
`audit.finding.answered`, `audit.finding.closed`, `audit.item.changed`, `audit.evidence.exported`. Broadcast-only (§3; not in the trail):
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
`DB_CONNECTION_STRING`, `DB_SYNC`, `JWT_SECRET`, OpenBao AppRole settings. The services it calls:
`RECORDS_URL` (http://localhost:3505), `EDRMS_URL` (http://localhost:3502), `BPM_URL`
(http://localhost:3503; findings).

# Auditor · read-only

*For testers and the Office of the Auditor-General. Last checked against the app on 12 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The auditor checks that the land records can be trusted: every document is exactly what was sealed,
every value can be traced to the documents, and the record's history is complete. The auditor
changes nothing. Their sign-offs and findings are added to the audit trail, and go on the blockchain
like everything else.

**You start on:** Audit. **Your menu:** Dashboard, Capture, Verify metadata, Documents (EDRMS),
Land record, Audit, Anchorings, Process & schema. Everything except Audit is view-only for you.

| You can | You cannot |
|---|---|
| Audit a land record against the blockchain and sign it off | Upload, review, file or correct documents |
| Raise findings, answer and close them | Create, change or approve land records |
| Search the whole audit trail and check that it is unbroken | Sign off an audit of a version you approved yourself |
| Download proofs and export evidence packs, to be checked outside the portal | |

The app keeps duties apart: someone who can **approve land records** cannot also **sign off
audits**. A registrar who later becomes an auditor still cannot sign off the audit of a version
they approved: another auditor must.

## How it works, in one minute

- **Every change is sealed.** Each land record version, filed document and audit sign-off gets a
  fingerprint: a short code that changes completely if anything in it changes.
- **Once an hour, the new fingerprints go to a public blockchain** as one batch. After that nobody,
  not even the registry, can change them without it showing.
- **You can only trust what is on the blockchain**, so an audit can be signed off only once
  everything in it is there and matches. On a real system that means waiting up to an hour after a
  version is approved. The status of each item says where it is:

| Status | Means |
|---|---|
| Waiting for next batch | Sealed in the portal; goes out with the next batch. Not ready to sign off |
| Sent to the blockchain | On its way, usually in a block within minutes. Not ready to sign off yet |
| On the blockchain | Written into a block. Can be signed off |
| Confirmed | 10 newer blocks on top of it: it can no longer be undone |

Every status names its batch, for example "Confirmed in batch 1,412 →", and links to it. Every term
on the audit screens has an **(i)**: click it for a short explanation.

What a batch puts on the blockchain, and exactly how its fingerprint is computed from the documents
and land records, is explained step by step in [What is on the blockchain](../what-is-on-the-blockchain.md).

## Audit a land record, start to finish

Live: this audits the real Erf 1873, Klein Windhoek, once the records officer and the registrar have
committed it (steps 5 to 7a of [the whole flow](../testing-the-portal.md#the-whole-flow)).

### 1. Find the record to audit

| # | Do | You should see |
|---|---|---|
| 1 | Open **Audit** | **How audit works** in three steps, a search, and the filters **Changed since last audit**, **Needs attention** and **All**, each with a count |
| 2 | Search "1873" | **Erf 1873, Klein Windhoek** with its owners, current version and **Proof** status, and under **Audit** the open audit, e.g. "v1–v2 · 3 new documents" with what is known of the blockchain check ("All match the blockchain ✓" or "Not all on the blockchain yet") |
| 3 | Click the record (or **Open**) | Its audit: the open audit (every version since the last sign-off), **Trail chain intact**, how many new documents match the blockchain, open findings |

### 2. Check against the blockchain

| # | Do | You should see |
|---|---|---|
| 4 | Click a version under **Versions**, tab **1 · Blockchain check** | "Matches the blockchain ✓", its proof (e.g. "Confirmed in batch 2 →") and fingerprint. A version not on the blockchain yet says it can be checked once it is there |
| 5 | Click a document in the table, tab **1 · Blockchain check** | Its own check and proof. **Review document** opens the scan with its metadata and history |
| 6 | Scroll to **Audit trail** at the bottom | Every action on the record and its documents, newest first: capture, filing, changes, submission, approval, commit, findings. **Show 25 more** goes back further. Each entry has its proof status, linked to its batch |
| 7 | Click **Verify** on an entry, e.g. "Committed version" | **Valid**: the entry is unchanged, links into the trail's chain, and its batch is on the blockchain |

If something does not match, the version or document shows **Changed since review ✕**: the record
must be reviewed and submitted again before it can be audited. Report it.

### 3. Check each version's changes

| # | Do | You should see |
|---|---|---|
| 8 | Click a version, tab **2 · Check changes** | What the version changed (old → new), and the documents it added |
| 9 | Compare the changes with the documents: e.g. the new owner against the deed of transfer. If they match, click **Changes match: mark checked** | "✓ You checked this version's changes". Do this for every version in the audit |
| 10 | If something is wrong, click **Doesn't match: raise finding** (on the current version), or **Raise finding** in a document's review, and describe it | The finding is open; the records officer and the registrar get a task. An open finding blocks the sign-off |
| 11 | When the finding is resolved, open it, type the answer and click **Answer and close** | "resolved by agreement". A corrected version, reviewed and on the blockchain, resolves it by itself |

### 4. Sign off

| # | Do | You should see |
|---|---|---|
| 12 | Click the card at the top, **Erf 1873, Klein Windhoek · v1–v3** (your range) | **Audit sign-off** with four checks: everything on the blockchain, everything matches, no open findings, every version's changes checked |
| 13 | When all four are ticked, click **Sign off v1–v3**, then **Sign off** | "Audit signed off. It goes on the blockchain with the next batch." The audit is one sign-off for all those versions; the next audit starts after them |
| 14 | After the next batch, open the record again | "✓ Audit signed off up to v3", by you, when, with its proof: "Confirmed in batch … →" |

If the button stays faded, the card says why: something is not on the blockchain yet (wait for the
next batch), a finding is open, a version is not checked, or you approved one of the versions.

### 5. Export the evidence pack

| # | Do | You should see |
|---|---|---|
| 15 | Click **Export evidence pack** | A zip file with the record's versions, documents, trail, sign-offs, findings and proofs, and its checksum. The export itself is written to the trail |
| 16 | Check it outside the portal (below) | **VALID** |

## Check a proof outside the portal

Anyone can check the registry's proofs without the portal, for example a bank, a court or a buyer's
lawyer.

1. **Get a proof file.** On a version's or document's **Blockchain check**, on the Land record's
   **History** tab or on a document's version history, click **Download proof**. Its **(i)** shows
   the command and the registry's wallet address. An evidence pack holds the proofs of a whole record.
2. **Get the verifier.** Open the public page **Check a proof yourself** (the link "Check it
   yourself" on the sign-in page; no account needed). It explains the steps, gives the verifier
   file (needs Node.js 18 or later) and shows the registry's anchoring wallet.
3. **Run it:** `node lrfe-verify.mjs proof.json --address <the wallet address>`, or the same with
   the evidence pack's zip file. **VALID** means the item is exactly as sealed, in its batch, and the
   batch was written to the blockchain by the registry's wallet. The page also links the transaction
   on a public blockchain explorer, a website run independently of the registry.

To read the batch's record on the explorer (label 8890: `batch`, `root`, `size`, `prev`) and see how
a proof leads to its `root`, see [What is on the blockchain](../what-is-on-the-blockchain.md).

## Search the whole trail

**Audit → Trail** answers "what did this person do", "what happened to this document" and "what
happened in this period".

| Do | You should see |
|---|---|
| **About** → A person, type a name (suggested from the trail), **Search** | Their actions, and what was done about them (e.g. the registrar approving their submission), oldest first, with when, who, what and the **Source** |
| **About** → A document, its number, e.g. EDR-NA-2026-000002 | Its history from "Captured a scan" to filing and corrections |
| **What** and **From / To** | Only one family of events (e.g. Documents), and only those days (both included) |
| **Details** on an entry | The event, what it is about, its fingerprint and data, its proof linked to its batch, and **Download proof** |
| **Check the trail** | "The trail is intact: every entry links to the one before it", or the first entry where it is broken: report that at once |

A highlighted row "Gap in the trail" means events were lost before they could be recorded. The gap
is recorded so that the trail is never passed off as complete: report it.

## Anchorings: what is on the blockchain

**Anchorings** (in the menu) lists every batch the portal has put on the blockchain.

- **Is it on the blockchain?** Search a land record number, document number, Erf or deed number:
  the answer in plain words ("Yes. Everything up to v3 is on the blockchain.") with its history,
  each line linked to its batch.
- Each batch shows what is on the blockchain (with a link to a public explorer) and what it covers:
  each land record version with the documents it is made of. **Open audit** takes you to the audit.
- A **Failed** batch never reached the blockchain; the next batch replaced it, so nothing is lost.

## Documents: two different checks

On a document in **Documents (EDRMS)**:

| Check | What it checks |
|---|---|
| **Check integrity** (top) | The stored file and its metadata against the fingerprint they were sealed with in the portal |
| **Verify against the blockchain** (on each version) | The version's fingerprint, recomputed and found in its batch, and the batch in the blockchain transaction, with the transaction linked to a public explorer |

A version that waits for the next batch says it can be checked against the blockchain once it is
there. **Request correction** is faded for you: auditors do not change records. If a value is
wrong, raise a finding.

## Common problems

| What happens | Why, and what to do |
|---|---|
| **Sign off** stays faded with "Some items go to the blockchain with the next batch" | Batches go out once an hour. Wait, then open the record again |
| "You approved v3, which is part of this audit, so another auditor must sign it off" | You approved that version as a registrar. Another auditor signs off |
| **Changes match: mark checked** is not there | The version is not on the blockchain yet, or does not match it: only what is on the blockchain can be trusted |
| A batch link says **Failed** | That batch never reached the blockchain; the batch after it replaced it. Follow "replaced by batch …" |
| The verifier says it could not check against the chain | Its public source of the blockchain was unavailable: try again later. It is not a failed check |

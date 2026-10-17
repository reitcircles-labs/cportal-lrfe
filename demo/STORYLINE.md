# Demo storyline (API-720)

The script for whoever gives the demo: who to sign in as, what to click, what to say, and what the audience should
see, from the scanned deeds to two committed land records and their audit. Keep it open next to the portal.

It follows the demo documents ([`documents/`](documents/README.md)): two properties, ten fictitious scans.
**Erf 2417, Olympia** is shown in detail; **Erf 815, Ludwigsdorf** goes faster. It takes 40 to 50 minutes; the
optional steps add 10.

Checked step by step in the browser on 16 October 2026 (version 0.1.0-95320f9, real AI): on a rehearsal install, and
then on the demo install itself with anchoring on (preview blockchain), including the auditor's sign-off.

## Before you start

- **The install is in its starting state:** a fresh, empty install that passed the readiness check, with the
  authenticators of the five users below set up. See [README.md](README.md), "Before every demo". Do not rehearse on
  the demo install: intake refuses a document it has already seen.
- **The ten PDFs are on the computer you present from.** The browser uploads them from there, not from the server.
  For example, on the laptop: `scp '<server>:projects/cportal-lrfe/demo/documents/*.pdf' ~/demo-documents/`.
- **Your phone** has the authenticator app with the five demo users, and you know the demo password.
- **Anchoring is on**: the readiness check shows, under Anchoring, the wallet readable, the blockchain node synced
  and enough funds ([README.md](README.md), "Anchoring for the demo"; after a server restart OpenBao must be
  unsealed first).
- **The portal is open** at `http://localhost:8088` (through the SSH tunnel). Use a normal (not private) browser
  window at full screen.

### The cast

| Act | Sign in as | Role | What they do |
|---|---|---|---|
| 1 | `k.iipinge@deeds.gov.na`, Kristofina Iipinge | Scan operator | Scans the deeds in |
| 2 | `a.mwandingi@deeds.gov.na`, Aina Mwandingi | Metadata reviewer | Checks what the AI read and files the documents |
| 3 | `j.gawaseb@deeds.gov.na`, Johannes !Gawaseb | Records officer | Builds the land records |
| 4 | `e.shivute@deeds.gov.na`, Elina Shivute | Registrar (supervisor) | Approves them |
| 5 | `m.nakale@oag.gov.na`, Maria Nakale | Auditor (Office of the Auditor-General) | Checks them |

### Switching roles

1. Bottom left, under **Signed in as**, click the sign-out arrow next to the name.
2. On **Sign in**: the next user's email, the demo password, **Sign in**.
3. **Enter your code**: the 6-digit code from the phone for that user, **Verify and sign in**.
4. Everyone starts on the **Dashboard**. Go straight to the menu item for the act (named in each act).

*Say, the first time:* "Every user has their own account, with a password and a code from their phone. What they
see and may do depends on their role: watch the menu change with each person."

### Do not show

- **The Dashboard**: its figures and parcels (Erf 1873, "29 documents awaiting review", the throughput chart) are
  sample data, not this install's, and a note under the greeting says so. Leave it at once for the act's menu item,
  also before opening the bell. If asked: "The Dashboard is a preview with sample figures; every other screen is live."
- **Uploading a file a second time**: intake refuses it as already captured (fine to show deliberately, see Act 1).

## Act 1 · Scan operator: the deeds come in (5 min)

Sign in as **`k.iipinge@deeds.gov.na`**, then **Capture**.

*Say:* "The registry's paper archive is being scanned. The scan operator puts each box of scans into the system as a
batch. As each file arrives, the AI reads it."

| # | Do | They see |
|---|---|---|
| 1.1 | **New batch**, source "Erf 2417, Olympia", **Create batch** | "Batch WDH-B001 created"; the batch card with its number, source, creator, "Documents 0" |
| 1.2 | **Drop scans here or choose files**: pick `01-…` to `06-…` (the six Erf 2417 files) | Under **Uploads**, each file "Queued for reading" |
| 1.3 | Wait (about a minute) and watch **Documents in WDH-B001** | Each row goes Queued → Reading → **In review**. **Read as** shows what the AI recognised: "Surveyor-General diagram A 318/1989", "Deed of grant G 64/1991", "Deed of transfer T 3120/1998", "Deed of sale", "Deed of transfer T 2876/2014", "Mortgage bond B 1944/2014". **Fields** counts what the reviewer still has to check |
| 1.4 | **New batch**, source "Erf 815, Ludwigsdorf", **Create batch**; upload `07-…` to `10-…` | A second batch, WDH-B002, read in the same way |

*Say, while it reads:* "These are image scans, without any text in them, as an archive scan is. The AI reads each one
like a person would: what kind of document it is, the deed number, the parties, their ID numbers, the property, the
extent. Nothing it reads is final: a reviewer checks every value against the scan."

*Point out:* T 2876/2014 shows **In review · read twice**: one value failed a format check (an ID number), so a
second model read the document too, and the two readings are compared field by field.

Optional (1 min): upload `05-…` again into either batch. "This file was already captured": the same scan never
enters twice, even renamed.

Sign out.

## Act 2 · Reviewer: check what the AI read, and file (10 min)

Sign in as **`a.mwandingi@deeds.gov.na`**, then **Verify metadata**.

*Say:* "The reviewer compares what the AI read with the scan. Only a person can accept a value; only then can the
document be filed in the EDRMS, the registry's document store, where it is sealed: a later change becomes a new
version, approved by a second person, and the original is kept."

The screen: the **Review queue** on the left (both batches, "N to check" per document), the scan in the middle, the
fields the AI read on the right. Opening a document reserves it for you.

### The SG diagram, A 318/1989 (document 01)

| # | Do | They see |
|---|---|---|
| 2.1 | In the queue under **WDH-B001**, click **A 318/1989** | "A 318/1989 · Surveyor-General diagram · ERF NO. 2417 OLYMPIA…", the scan, 8 fields, "0 of 8 reviewed" |
| 2.2 | Click **Area** | Its evidence, "1 050 square metres", and the place on the scan it came from |
| 2.3 | **Accept 7 clean fields** (the number can differ) | The fields the AI was sure of turn blue. **Survey date · check** stays open |
| 2.4 | Click **Survey date** | "Could not read this as a date": the diagram gives only the month ("June 1989"). Compare with the scan, click its ✓ |
| 2.5 | **Approve & file to EDRMS** | "Filed as EDR-NA-2026-000001: A 318/1989 is now a sealed document of record". The next document opens (it may be from WDH-B002) |

*Say:* "The SG diagram defines the parcel and its area. The land record will take its extent from it."

### The next three, quickly: G 64/1991, T 3120/1998, the deed of sale (documents 02 to 04)

In the queue under **WDH-B001**, click **G 64/1991**, then **T 3120/1998**, then `04-erf-2417-deed-of-…` (the deed
of sale has no deed number, so the queue shows its file name), all before T 2876/2014. For each: **Accept N clean
fields**, look at each open field on the scan and click its ✓, **Approve & file to EDRMS**. Open fields you may see:
"Prior title … is not in the EDRMS yet" (the AI read every document at upload, before any was filed: information
only). In the deed of sale, point at **Purchaser 2 ID no.**: 81071100562, Frieda Haufiku's full ID number, needed in
a minute.

### The deed of transfer, T 2876/2014 (document 05): the intended error

| # | Do | They see |
|---|---|---|
| 2.6 | In the queue, click **T 2876/2014** ("1 conflict") | 17 fields, "read by two models", and the note "Read a second time … the two readings are combined field by field" |
| 2.7 | Click **Transferee 2 ID no.** (marked **· conflict**) | The value 8107110056, its evidence "Identity Number 8107110056", and the check **"A Namibian ID number has 11 digits; this has 10"**. Filing is blocked |
| 2.8 | *Say:* "The deed itself is wrong: a digit is missing. The deed of sale signed by the same buyers, document 04, has her full number." Type **81071100562** in the field, press **Enter** | The field shows **· corrected**, the check disappears |
| 2.9 | **Accept N clean fields** | The fields where the two readings differ stay open, marked **· check**. Which ones varies from run to run, for example **Transferor** "The second reading gave 'MARTHA GARISEB'" (with "Holder under T 3120/1998", since T 3120/1998 is filed: Andreas Kambonde owned it), **Marital regime** "The first reading gave 'in community of property'", **Consideration** or **Registration date** written differently |
| 2.10 | Click each open field, compare with the scan, click its ✓ (or correct it) | "17 of 17 reviewed" |
| 2.11 | **Approve & file to EDRMS** | "Filed as EDR-NA-2026-000005" |

*Say, at 2.9:* "Where two models disagree, the portal does not guess: it asks the reviewer to look."

*Say:* "The correction is recorded: who changed what, from what the AI read to what the reviewer decided. Had the
wrong number been filed, the land record could not be submitted later: its check of ID numbers would refuse it."

### The poor scan, B 1944/2014 (document 06)

| # | Do | They see |
|---|---|---|
| 2.12 | Click **B 1944/2014**, and **Open scan** | The scan opens in a new tab: skewed, faint, a reception stamp over the text. Back to the portal tab |
| 2.13 | *Say:* "Even on a poor scan the AI read every field." **Accept N clean fields** | Two or three fields stay open, for example **Mortgagor** ("The value does not appear in the quoted evidence"), **Title deed** ("Prior title T 2876/2014 is not in the EDRMS yet"), **Registration date** ("The quoted evidence is not on page 1") |
| 2.14 | Compare both with the scan, ✓ each, **Approve & file to EDRMS** | "Filed as …" |

### The other documents (quickly)

File the four Erf 815 documents in the same way (A 1127/1972, T 1659/1987, T 5530/2021, the rates clearance by its
file name `10-erf-815-rates-clearan…`): open, **Accept N clean fields**, ✓ the open fields after a look at the scan,
**Approve & file to EDRMS**. You can stop talking here, or fast-forward by saying what is happening.

What you may see flagged (the real AI varies a little from run to run), all accepted after a look at the scan:

| Document | Flag | Why |
|---|---|---|
| Deeds 08, 09 (and earlier 02 to 04, 06) | "Prior title … is not in the EDRMS yet", "Diagram … is not in the EDRMS yet" | The AI read them all at upload, before anything was filed. Information: the document it cites is filed now, or (T 410/1973 in 08) is not part of the demo |
| SG diagram 07 | "Could not read this as a date" ("March 1972") | Only the month is given, as in 01 |
| Deeds 08, 09 | "The quoted evidence is not on page 1" (e.g. registration date, conveyancer) | The value is on page 2: check it there |
| Deed 09 | Consideration "inheritance": "No amount (e.g. inheritance or donation)" | Information: the heirs inherited it |
| Rates clearance 10 | none ("Clean") | |

At the end, **Capture** shows every document as **Filed** with its EDRMS number.

Sign out.

## Act 3 · Records officer: build the land record (10 min)

Sign in as **`j.gawaseb@deeds.gov.na`**, then **Land record (create/finalize)**.

*Say:* "Now the deeds become a land record: one record per parcel, built from its filed documents. The portal works
out the owners and the chain of title from the deeds; the officer decides."

### Erf 2417, Olympia

| # | Do | They see |
|---|---|---|
| 3.1 | **New record**, **Find a filed document**: type **T 2876/2014**, pick it, **Create record** | "Erf 2417, Olympia created": **LR-NA-2026-000001 · Draft version 1**, registration division K, T 2876/2014 linked. The parcel was read from the deed |
| 3.2 | Look at **Add documents from the EDRMS**, **Matching this parcel** | The other five documents, each with why it matches: "SG diagram cited by T 2876/2014", "Cites T 2876/2014 as prior title" (the bond), and so on |
| 3.3 | **+ Add** on each of them | "… added to Erf 2417, Olympia" each time; **Documents 6** |
| 3.4 | **Registered owners** (on the right, or below the tab on a laptop screen: scroll down): "From the documents: SIMON HAUFIKU 1/2, FRIEDA HAUFIKU 1/2". Click **Use these owners** | "Owners taken from the documents": both owners with ID number, share and "Under T 2876/2014". Frieda's ID is the corrected 81071100562 |
| 3.5 | **Details** tab: **Use 1 050 m² from the documents**, **Tenure** Freehold | Extent 1050 m², "From EDR-NA-2026-000001" (the SG diagram) |
| 3.6 | Still in **Details**, under **Encumbrances**: **Use B 1944/2014 from the documents**, then **Save details** | "Encumbrances taken from the documents": Bond, B 1944/2014, Omaruru Building Society Limited. Then "Details saved"; the header shows Extent 1 050 m², Freehold, 6 linked documents |
| 3.7 | **Chain of title** tab | 1991 Deed of grant G 64/1991: Government → Municipal Council of Windhoek; 1998 T 3120/1998: Municipal Council → Andreas Kambonde; 2014 T 2876/2014: Andreas Kambonde → Simon and Frieda Haufiku, "held under T 3120/1998" |
| 3.8 | **Record checks** (under **Registered owners**) | **5 / 5 required**: Shares add up to 1 · Chain of title (G 64/1991 → T 3120/1998 → T 2876/2014) · Extent matches the SG diagram (A 318/1989) · ID numbers · Documents describe this parcel. Also ✓ Documents are current, Values from the documents |
| 3.9 | **Submit for review**, then **Submit for review** in the box | "Erf 2417, Olympia submitted for review": status **In review**, "Waiting for approval by a second person". Nothing can be changed now |

*Say, at the checks:* "These checks must all pass before the record can go for approval: every share adds up, every
seller was the previous owner, the area matches the survey, every ID number is valid. A misread name or a wrong ID
number stops the record here."

*Say, at the bond:* "The bond comes from the filed mortgage bond, like the owners and the extent: the record shows the
property is mortgaged, and to whom."

### Erf 815, Ludwigsdorf (quickly)

| # | Do | They see |
|---|---|---|
| 3.10 | **New record** from **T 5530/2021**; **+ Add** the three matching documents (T 1659/1987, A 1127/1972, the rates clearance) | Erf 815, Ludwigsdorf, 4 linked documents |
| 3.11 | **Use these owners** | HELENA NDAPANDULA SHIPANGA 1/2, JOHANNES TUHAFENI SHIPANGA 1/2: the late father's erf passed to his two children |
| 3.12 | **Details**: **Use 1 487 m² from the documents**, Tenure Freehold, **Save details**. **Chain of title** | T 1659/1987: Hendrik Johannes Visagie → Petrus Nangolo Shipanga; T 5530/2021: Estate Late Petrus Nangolo Shipanga → the two children |
| 3.13 | **5 / 5 required**, **Submit for review** twice | Submitted for review |

Optional (1 min): click the bell (top right). *Say:* "The officer has no task to approve their own record: a second
person must. That is four-eyes." Close it.

Sign out.

## Act 4 · Registrar: approve (3 min)

Sign in as **`e.shivute@deeds.gov.na`**, then **Land record (create/finalize)** (not the Dashboard behind the
approval box). The work comes to the bell.

*Say:* "The registrar approves. Not the officer who built the record, and not the reviewer who filed its documents."

| # | Do | They see |
|---|---|---|
| 4.1 | Click the bell (top right) | Two tasks: "Approve land record LR-NA-2026-000001 (Erf 2417, Olympia) version 1" and the same for Erf 815 |
| 4.2 | Click the Erf 2417 task | **Submitted by** Johannes !Gawaseb, the **Checks**, each ✓ (shares, G 64/1991 → T 3120/1998 → T 2876/2014, extent matches A 318/1989, ID numbers, documents describe this parcel, current, from the documents), and **What this version contains**: every field, both owners, the six documents |
| 4.3 | **Approve** | "Erf 2417, Olympia approved: version 1 is now current" |
| 4.4 | The same for Erf 815 | "Erf 815, Ludwigsdorf approved: version 1 is now current" |
| 4.5 | **Land record (create/finalize)**, click **Erf 2417, Olympia**, **History** tab | **Committed**, **Version 1 · current**: committed, submitted by Johannes !Gawaseb, approved by Elina Shivute, **Seal verified**, **Seal chain intact**, and everything the version contains |

*Say:* "The record is now sealed. It is never edited: a change is a new version that goes through the same review,
and every version is kept. 'Waiting for next batch' is the blockchain step: the seal goes to a public blockchain
with the next batch. On a live system once an hour; on this demo install every five minutes. The auditor will check
it there."

Sign out.

## Act 5 · Auditor: can the record be trusted? (15 min)

Sign in as **`m.nakale@oag.gov.na`**, then **Audit**.

*Say:* "The auditor, from the Office of the Auditor-General, changes nothing. They check that every document is
exactly what was sealed, every value can be traced to a document, and the history is complete."

What the auditor checks, in this order:

1. **The trail is unbroken**: nothing was removed or altered after the fact.
2. **Every document is exactly as sealed**: file and metadata unchanged since filing.
3. **The record follows from its documents**: the owners, the extent, the chain of title.
4. **Who did what**: capture, review, corrections, building the record, approval, four-eyes respected.
5. **What is open**: findings, and whether everything is on the blockchain, before signing off.

**Timing.** The approved version reaches the blockchain within about 10 minutes of Act 4. One batch is on its way at a
time: the next goes out once the previous one is confirmed (10 blocks, 3 to 7 minutes on preview) and at least 5
minutes after the previous one was created. So the auditor looks at the record and the trail first, raises the
finding, and signs off at the end. In the rehearsal: approved 23:19, on the blockchain 23:26, signed off 23:27. Batch
numbers below are those of the rehearsal; yours can differ.

| # | Do | They see |
|---|---|---|
| 5.1 | **Audit** opens on **Land records**, with **How audit works** open at the top: let it be read | Three steps: on the blockchain, you check and sign off, your audit goes on the blockchain too |
| 5.2 | Below it, the list (**Changed since last audit 2**) | Both records with owners, current version (v1), **Proof** status and **Audit**: "v1 · 6 new documents" |
| 5.3 | **Open** on **Erf 2417, Olympia** | **Trail chain intact**, "6 of 6 new documents match the blockchain" (the documents went out in an earlier batch), "0 open findings"; **Versions**: v1, approved by Elina Shivute, "Waiting for next batch" (or already **On the blockchain**); **Documents in v1** (6, by type, each **Matches ✓**); the **Audit sign-off** card; the **Audit trail** |
| 5.4 | Scroll through the **Audit trail** | Every action, newest first: approval and commit by Elina Shivute, submission and every draft change by Johannes !Gawaseb, each filing by Aina Mwandingi, each with its fingerprint and proof: the older entries **On the blockchain** or **Confirmed** with their batch, the approval and commit **Waiting for next batch**. Entries by "System" or "land-records" are automatic steps (a review started, a task created). **Show 25 more** goes back to the scans being read |
| 5.5 | **Verify** on an entry that is already on the blockchain, e.g. "Filed document" (not on a waiting one: that says "Not on the blockchain yet") | **Valid**: the entry is unchanged, links into the trail's chain, and its batch is on the blockchain (wording from the automated tests; on the demo install only the waiting case was captured) |
| 5.6 | In **Documents in v1**, **Review** on **T 2876/2014** | "No issues · matches the blockchain, no open finding"; **1 · Blockchain check**: Fingerprint calculated, Same fingerprint as on the blockchain, "Match: This file is exactly the document that was sealed. Nothing has changed since."; **2 · Metadata** (Transferee 2 ID no. 81071100562); **3 · Findings**. *Say:* "This is how the auditor checks that the owners come from the deed." **Next ›** steps through the documents. Show this before the sign-off: afterwards the list shows only what is new since it |

### A finding, end to end (optional, 5 min)

Shows how the auditor raises an issue and how it is closed. Do it on **Erf 815** so Erf 2417 stays clean.

| # | Do | They see |
|---|---|---|
| 5.7 | **← All land records**, **Open** on **Erf 815, Ludwigsdorf**; **Review** on **T 5530/2021**; **Raise finding** | "Raise a finding on T 5530/2021?": the records officer and the records supervisor each get a task; while it is open, the audit can't be signed off |
| 5.8 | Type "The estate transfer cites Master's reference E 2207/2020: please confirm the executor's letter of authority is on file.", **Raise finding** | The document shows **Open · Auditor finding #…**; the record "1 open finding"; the sign-off card "No open findings: 1 open" and why it blocks |
| 5.9 | Sign out; sign in as **`j.gawaseb@deeds.gov.na`**; **Land record (create/finalize)**; bell → **Audit finding on EDR-NA-2026-000009 …** | Who raised it, the finding, the document and record, a due date. **Acknowledge** |
| 5.10 | Sign out; sign in as **`m.nakale@oag.gov.na`**; **Audit** → **Erf 815** → **Review** on T 5530/2021; under the finding type the answer "Letter of authority seen on the estate file on 16 October 2026; agreed with the registrar.", choose **Resolved by agreement outside the portal**, **Answer and close** | "Finding #… · resolved by agreement", with both entries (raised, answered and closed) by name, role and time |

*Say:* "A finding is resolved either by a corrected version of the record, reviewed and approved again, or, as here,
by the auditor closing it with the reason. Either way it stays in the record's audit for good."

### The whole trail, and the documents

| # | Do | They see |
|---|---|---|
| 5.11 | **Audit** → **Trail** tab. **About**: A person, **Name** "Aina Mwandingi", **Search** | Everything the reviewer did, oldest first: enrolled her authenticator, signed in, filed each document, sent each scan for filing |
| 5.12 | **Check the trail** | "The trail is intact: every entry links to the one before it." |
| 5.13 | **Documents (EDRMS)**, search **T 2876/2014**, open it, **Check integrity** | "Integrity verified · version 1.0 · content matches its SHA-256 · seal intact"; the verified metadata with Transferee 2 ID no. **corrected**; **Version history**: v1.0 filed by Aina Mwandingi; the ISO 23081 record metadata (capturer, reviewer) |
| 5.14 | Back in **Audit**, open Erf 2417, **Export evidence pack** | A zip file downloads: the record's versions, documents, trail, findings and proofs, to be checked outside the portal |

### On the blockchain, and the sign-off

*Say:* "Every action is sealed with a fingerprint the moment it happens. The fingerprints go to a public blockchain
in batches, and from then on nobody, not even the registry, can change them without it showing. The auditor signs
off only what is on the blockchain."

| # | Do | They see |
|---|---|---|
| 5.15 | **Audit** → **Open** on **Erf 2417, Olympia** | **Versions**: v1 **On the blockchain**. Not yet ("Waiting for next batch")? Show 5.19 to 5.21 first, then come back |
| 5.16 | Click **v1 · current**, tab **2 · Check changes**; compare with the deed; **Changes match: mark checked** | v1 now shows "✓ Checked". The button is there only once the version is on the blockchain |
| 5.17 | Click the card **Erf 2417, Olympia · v1** | **Audit sign-off** with four checks ticked: Everything on the blockchain ("Yes"), Everything matches the blockchain, No open findings, Every version's changes checked ("1 of 1 · by you") |
| 5.18 | **Sign off v1**, then **Sign off** in the box | "Audit signed off. It goes on the blockchain with the next batch." The card: "✓ Audit signed off up to v1, by Maria Nakale", "Waiting for next batch"; "Nothing to audit" until a new version is committed |

*Say:* "One sign-off for everything committed since the last audit. The sign-off itself is sealed and goes on the
blockchain too: no one can quietly undo it."

### Is it on the blockchain? Check it yourself

| # | Do | They see |
|---|---|---|
| 5.19 | **Anchorings** (menu), **Is it on the blockchain?**: type **Erf 2417**, **Search** (the "Try" buttons are examples, not this install's) | "LR-NA-2026-000001 · Erf 2417, Olympia · On the blockchain · Yes. Everything up to v1 is on the blockchain." Its history, newest first: the audit sign-off (waiting for the next batch, or in it), version v1 committed (**Batch 3 →**), each of the six documents (**Confirmed**, **Batch 2 →**). Shown before the sign-off (5.15 fallback): no sign-off line yet, and while v1 still waits, it says so instead of "Yes" |
| 5.20 | **Batch 3 →** (the batch with version v1; its number can differ) | **Batch 3**: Created → Sent to the blockchain → On the blockchain (in block …) → Confirmed (N of 10 confirmations); **What is on the blockchain**: the combined fingerprint, the previous batch's, the transaction; **What it covers**: both land records' v1, each made of documents already on the blockchain |
| 5.21 | **View on a blockchain explorer ↗** | The transaction on preview.cardanoscan.io, with the batch, fingerprint and previous fingerprint in its metadata (label 8890). *Say:* "This is a public website run independently of the registry. Anyone can check it, without the portal: see **Check it yourself** and **Why trust the explorer?** on this page." |

Sign out.

## Closing (2 min)

*Say:* "Ten scanned deeds became two land records: read by the AI, checked and corrected by a person, sealed in the
document store, built into records whose checks confirm the chain of title, approved by a second person, written to
a public blockchain, and signed off by the auditor, with every step in an unbroken trail. Each person saw only what
their role allows."

Questions often asked, and where to show the answer:

| Question | Show |
|---|---|
| "What if the AI reads something wrong?" | Act 2, T 2876/2014: the reviewer corrects it; the correction is recorded |
| "Can someone change a filed deed?" | As the reviewer: Documents (EDRMS) → a document → **Request correction**: a new version, approved by a second reviewer; v1.0 is kept |
| "Can a record be changed after approval?" | As the records officer: Land record → **Change record**: a new draft version, reviewed again; History keeps every version |
| "Who can see what?" | Sign in as different users: the menu differs per role |

## If something goes wrong

| What happens | What to do |
|---|---|
| A document stays **Queued** or **Reading** for minutes | The AI service is slow; carry on with the documents that are ready. A **Failed** one: as the reviewer, **Retry** |
| "This file was already captured" for a file you did not upload yet | The install was not fresh (a rehearsal ran on it). Show what is there, or start fresh after the demo |
| A field is flagged that is not in this script | The real AI can vary. Click it, read the check, compare with the scan, accept or correct |
| **Submit for review** stays disabled | Read **Record checks**: usually a document not linked (check **Matching this parcel**) or **Tenure** not set |
| "Could not save: The record is not complete yet" | **Tenure** is not set: Details → Tenure → Save details |
| The 6-digit code is refused | Wait for the next code on the phone (a code works once), and check it is the right user's entry |
| No task in the registrar's bell | The record was not submitted yet (Act 3, 3.9), or the bell needs a click to refresh |
| v1 still "Waiting for next batch" 10 minutes after the approval | Anchorings → **In progress** shows the batch on its way and its confirmations. If nothing is in progress, the audit service cannot sign: the readiness check says why (OpenBao sealed, funds, the node) |
| **Changes match: mark checked** is not there | The version is not on the blockchain yet: come back to it after 5.19 to 5.21 |

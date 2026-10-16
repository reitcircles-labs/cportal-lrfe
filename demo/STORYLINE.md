# Demo storyline (API-720)

The script for whoever gives the demo: who to sign in as, what to click, what to say, and what the audience should
see, from the scanned deeds to two committed land records and their audit. Keep it open next to the portal.

It follows the demo documents ([`documents/`](documents/README.md)): two properties, ten fictitious scans.
**Erf 2417, Olympia** is shown in detail; **Erf 815, Ludwigsdorf** goes faster. It takes 35 to 45 minutes; the
optional steps add 10.

Checked step by step on a rehearsal install (version 0.1.0-95320f9, real AI, anchoring off) on 16 October 2026. The
steps for an install with anchoring on (end of Act 5) were not rehearsed.

## Before you start

- **The install is in its starting state:** a fresh, empty install that passed the readiness check, with the
  authenticators of the five users below set up. See [README.md](README.md), "Before every demo". Do not rehearse on
  the demo install: intake refuses a document it has already seen.
- **The ten PDFs are on the computer you present from.** The browser uploads them from there, not from the server.
  For example, on the laptop: `scp '<server>:projects/cportal-lrfe/demo/documents/*.pdf' ~/demo-documents/`.
- **Your phone** has the authenticator app with the five demo users, and you know the demo password.
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
  sample data, not this install's. Leave it at once for the act's menu item, also before opening the bell.
- **Anchorings**, while anchoring is off (the readiness check says whether it is on): the menu item, the **Anchorings**
  tab on the Audit screen, and the **see when →** links next to "Waiting for next batch" all lead there. It lists no
  batches and says the first batch goes out within an hour, which it won't.
- **Uploading a file a second time**: intake refuses it as already captured (fine to show deliberately, see Act 1).

The note at the foot of each page ("Dashboard and land records still show demo data … until the land-records service
is connected") is out of date (API-722): only the Dashboard is sample data; the Land record screen is live. If asked:
"That note is from before the land records went live; everything you see outside the Dashboard is real."

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
| 3.6 | Still in **Details**, under **Encumbrances**: **+ Add encumbrance**, type **Bond**, reference **B 1944/2014**, in favour of **Omaruru Building Society Limited**; **Save details** | "Details saved"; the header shows Extent 1 050 m², Freehold, 6 linked documents |
| 3.7 | **Chain of title** tab | 1991 Deed of grant G 64/1991: Government → Municipal Council of Windhoek; 1998 T 3120/1998: Municipal Council → Andreas Kambonde; 2014 T 2876/2014: Andreas Kambonde → Simon and Frieda Haufiku, "held under T 3120/1998" |
| 3.8 | **Record checks** (under **Registered owners**) | **5 / 5 required**: Shares add up to 1 · Chain of title (G 64/1991 → T 3120/1998 → T 2876/2014) · Extent matches the SG diagram (A 318/1989) · ID numbers · Documents describe this parcel. Also ✓ Documents are current, Values from the documents |
| 3.9 | **Submit for review**, then **Submit for review** in the box | "Erf 2417, Olympia submitted for review": status **In review**, "Waiting for approval by a second person". Nothing can be changed now |

*Say, at the checks:* "These checks must all pass before the record can go for approval: every share adds up, every
seller was the previous owner, the area matches the survey, every ID number is valid. A misread name or a wrong ID
number stops the record here."

*Say, at the bond:* "The officer adds the bond by hand, from the filed mortgage bond: the record shows the property
is mortgaged."

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
and every version is kept. 'Waiting for next batch' is the blockchain step: on a live system the seal goes to a
public blockchain within the hour. On this demo install that is switched off; the auditor will come back to it."

Sign out.

## Act 5 · Auditor: can the record be trusted? (10 min)

Sign in as **`m.nakale@oag.gov.na`**, then **Audit**.

*Say:* "The auditor, from the Office of the Auditor-General, changes nothing. They check that every document is
exactly what was sealed, every value can be traced to a document, and the history is complete."

What the auditor checks, in this order:

1. **The trail is unbroken**: nothing was removed or altered after the fact.
2. **Every document is exactly as sealed**: file and metadata unchanged since filing.
3. **The record follows from its documents**: the owners, the extent, the chain of title.
4. **Who did what**: capture, review, corrections, building the record, approval, four-eyes respected.
5. **What is open**: findings, and whether everything is on the blockchain, before signing off.

| # | Do | They see |
|---|---|---|
| 5.1 | **Audit** opens on **Land records**, with **How audit works** open at the top: let it be read | Three steps: on the blockchain, you check and sign off, your audit goes on the blockchain too |
| 5.2 | Below it, the list (**Changed since last audit 2**) | Both records with owners, current version (v1), **Proof** status and **Audit**: "v1 · 6 new documents" |
| 5.3 | **Open** on **Erf 2417, Olympia** | **Trail chain intact**, "0 of 6 new documents match the blockchain", "0 open findings"; **Versions** (v1, approved by Elina Shivute); **Documents in v1** (6, by type); the **Audit sign-off** card; the **Audit trail** |
| 5.4 | Scroll through the **Audit trail** | Every action, newest first: approval and commit by Elina Shivute, submission and every draft change by Johannes !Gawaseb, each filing by Aina Mwandingi, each with its fingerprint. Entries by "System" or "land-records" are automatic steps (a review started, a task created). **Show 25 more** goes back to the scans being read |
| 5.5 | Click **v1 · current**, tab **2 · Check changes** | What version 1 contains, field by field (Before — / After), the owners and the documents |
| 5.6 | In **Documents in v1**, **Review** on **T 2876/2014** | The document's own check (**Fingerprint calculated**), its sealed **Metadata** (Transferee 2 ID no. 81071100562) and **Findings**. *Say:* "This is how the auditor checks that the owners come from the deed." **Next ›** steps through the documents |

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

### Signing off, and the blockchain

**With anchoring off** (the demo default), say this and go to the closing; the sign-off stays closed:

*Say:* "Every action is sealed with a fingerprint the moment it happens. On a live system, once an hour those
fingerprints go to a public blockchain, and from then on nobody, not even the registry, can change them without it
showing. The auditor signs off only what is on the blockchain: see the card, 'Everything on the blockchain', and
'Waiting for next batch' next to each item. That is switched off on this demo install."

**With anchoring on** (only if the readiness check shows it on and the last batch went out after Act 4; batches go
out once an hour): on Erf 2417, each document and version shows **On the blockchain** or **Confirmed** with its batch.
Click **v1**, **2 · Check changes**, **Changes match: mark checked**; the four checks of the sign-off card are ticked;
**Sign off v1**, **Sign off**: "Audit signed off. It goes on the blockchain with the next batch."

Sign out.

## Closing (2 min)

*Say:* "Ten scanned deeds became two land records: read by the AI, checked and corrected by a person, sealed in the
document store, built into records whose checks confirm the chain of title, approved by a second person, and checked
by the auditor (the sign-off follows once everything is on the blockchain), with every step in an unbroken trail.
Each person saw only what their role allows."

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

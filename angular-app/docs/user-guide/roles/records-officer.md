# Records officer

*For testers and records-desk staff. Last checked against the app on 6 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The records officer builds the **land record** of a parcel (an erf or a farm) from its filed
documents: deeds of grant and transfer, survey diagrams, bonds. Linked together, they form the
**chain of title**, from which the portal works out the registered owners and their shares. When the
record is complete and every check passes, the records officer **submits it for review**. A second
person who may finalize records (the registrar, or another records officer) approves it. Only then
does that version become the current record. It is sealed and can only be superseded by a later,
reviewed version, never edited.

**You start on:** Land record. **Your menu:** Dashboard, Verify metadata (view only), Documents
(EDRMS), Land record, Process & schema, and the bell (**Tasks**).

| You can | You cannot |
|---|---|
| Create land records, link and remove documents, edit a draft, comment | Upload, review or file documents |
| Submit a record for review, withdraw it before the decision | Approve a record you submitted yourself (a second person must) |
| Approve or return records that **other** officers submitted (from the bell) | Change a filed document (ask a reviewer for a correction) |

## The Land record screen

- **Land records** (left): every record with its number (LR-NA-…) and status, filters (**All**,
  **Draft**, **In review**, **Committed**, **Needs review**), a search (record number, parcel, owner
  or deed) and **New record**.
- **The record** (right): its number and version, status, parcel, extent, tenure and number of linked
  documents, with the buttons that fit its state: **Add documents** and **Submit for review** on a
  draft; **Withdraw from review** while it waits; **Change record** once it is committed.
- Tabs:
  - **Documents**: the linked documents, each pinned to the EDRMS version it was linked at, and a
    panel to add more.
  - **Chain of title**: the deeds in date order, who transferred to whom.
  - **Details**: parcel, tenure, extent, encumbrances, other attributes.
  - **History**: every approved version.
  - **Comments**: a discussion for reviewers, the registrar and auditors.
- Side panels:
  - **Registered owners**: names, ID numbers, shares, and where each came from.
  - **Record checks**: five required checks, which must all pass before you can submit, and two
    warnings for the reviewer.

Everything is saved as you go. Other people see your record, and the person who approves it sees
exactly what you did.

## Build Erf 1873 from the sample documents

**Before you start:** a reviewer has filed samples **03** (SG A 412/2007), **04** (T 2210/2008) and
**05** (T 4521/2019, with Tomas Nghishidi's ID corrected to 01112500379). See
[the whole flow](../testing-the-portal.md#the-whole-flow). Samples 01 and 02 are optional: with the
real AI, if they are filed too, the chain of title starts at the 1978 grant (skip them with the
canned AI, see the note below).

| # | Do | You should see |
|---|---|---|
| 1 | Sign in as the records officer | **Land record**. On a fresh system the list is empty: "No land record selected" |
| 2 | **New record** → **From a filed document**, type **T 2210/2008**, pick it, **Create record** | "Erf 1873, Klein Windhoek created". The record shows **LR-NA-2026-… · Draft version 1**, status **Draft**, registration division K, and **T 2210/2008** under **Linked documents**. The portal read the parcel from the deed |
| 3 | Look at **Add documents from the EDRMS**, filter **Matching this parcel** | **A 412/2007** ("SG diagram cited by T 2210/2008") and **T 4521/2019** ("Cites T 2210/2008 as prior title"), each also "Property: Erf 1873, Klein Windhoek", with **+ Add**. T 2210/2008 shows **In this record** |
| 4 | **+ Add** on **A 412/2007**, then on **T 4521/2019** | "A 412/2007 added to Erf 1873, Klein Windhoek", then the same for T 4521/2019. Three linked documents, each with its EDRMS number and version |
| 5 | Look at **Registered owners** | "No owners yet", and a box **From the documents: Maria Nghishidi 1/2, Ndapewa Nghishidi 1/4, Tomas Nghishidi 1/4**. The late Petrus Nghishidi's half passed to his two children; Maria kept hers |
| 6 | Click **Use these owners** | "Owners taken from the documents". Each owner with ID number, share and "Under T 2210/2008" or "Under T 4521/2019"; Tomas Nghishidi with 01112500379 |
| 7 | **Details** tab: **Use 1 214 m² from the documents**, set **Tenure** to Freehold, **Save details** | "Extent taken from the documents", then "Details saved". The header shows Extent 1 214 m² and Freehold |
| 8 | **Chain of title** tab | 2008: Johannes Shikongo → Petrus Nghishidi, Maria Nghishidi, registered 14 March 2008. 2019: Estate of the late Petrus Nghishidi → Ndapewa Nghishidi, Tomas Nghishidi, held under T 2210/2008 |
| 9 | Look at **Record checks** | **5 / 5 required**: Shares add up to 1, Chain of title (T 2210/2008 → T 4521/2019), Extent matches the SG diagram, ID numbers (all valid), Documents describe this parcel. Also ✓: Documents are current, Values from the documents. **Submit for review** is enabled |
| 10 | **Submit for review** | "Submit Erf 1873, Klein Windhoek for review?" listing "Owners: Maria Nghishidi 1/2, Ndapewa Nghishidi 1/4, Tomas Nghishidi 1/4" |
| 11 | **Submit for review** in that box | "Erf 1873, Klein Windhoek submitted for review". Status **In review**, "Waiting for approval by a second person", **Withdraw from review**. Nothing can be changed now. The registrar has a task in their bell |

> **On a system with the "canned" AI** (`EXTRACTION_PROVIDER=mock`, used by the automated tests)
> every deed reads as a copy of T 2210/2008 with the deed number from its file name (sample 03 reads
> as SG diagram A 412/2007). The reviewer must then type T 4521/2019's values while reviewing sample
> 05: registration date, prior title, transferor, the two transferees with their ID numbers and the
> share. Skip samples 01 and 02: 01 would be filed as T 2210/2008 itself and block sample 04. See the table in the [samples README](../../samples/README.md#what-the-ai-should-read).
> Otherwise T 4521/2019 cites the wrong prior title and names the wrong owners, and the checks show
> it.

## After the review

| What happened | You should see, and what to do |
|---|---|
| The registrar **returned** it | Status **Draft**, and a banner "Returned by the reviewer: …" with their comment. Fix what they ask (a document, the owners, a detail), then **Submit for review** again |
| The registrar **approved** it | Status **Committed**, "Version 1". The **History** tab shows version 1 with who submitted it, who approved it, when, and **Seal verified** |
| You want it back before a decision | **Withdraw from review**, then **Withdraw** in the box: "Withdrawn from review". The registrar's task disappears and the draft can be edited again |

## Change a committed record

A committed record is never edited in place. A change is a new version that goes through review in
the same way.

| # | Do | You should see |
|---|---|---|
| 1 | Open the committed record, click **Change record** | "A new draft is open…". The header shows **Draft version 2 · current is version 1**. Version 1 stays the official record until version 2 is approved |
| 2 | Make the change, e.g. **Details** → change the value of **zoning** to "General Residential 1" (or **+ Add attribute** if the record has none), **Save details** | "Details saved" |
| 3 | **Submit for review** | The registrar's review shows **Changes since version 1**: only what you changed |
| 4 | Once approved | **History** shows version 2 (current) and version 1, each with **Seal verified**, and "Seal chain intact" |

## When a linked document is corrected in the EDRMS

When a reviewer corrects a filed document (with a second reviewer's approval), every land record that
uses it is flagged. Nothing in the record changes by itself.

| # | Do | You should see |
|---|---|---|
| 1 | Open the record | Status **Needs review**, and a banner "Document updated: EDR-NA-… v1 → v2. Review needed." with the reviewer's reason. On the document's row: "v2.0 in EDRMS" |
| 2 | **Change record**, then **Use v2.0** on that document | "… updated to the newer version". If the correction changed an owner's details, **Registered owners** offers them under **From the documents**, and the check **Values from the documents** warns until you click **Use these owners** |
| 3 | **Submit for review**. Once approved | The flag is gone; the history shows the new version with the document at v2.0 |

## Things to try

| Do | You should see |
|---|---|
| On a draft, remove **T 2210/2008** with its ✕ (and **Remove document** in the box) | The required checks still pass (the first deed in the record starts the chain), but **From the documents** now suggests only "Ndapewa Nghishidi 1/4, Tomas Nghishidi 1/4" and **Values from the documents** warns "owners differ from the title deeds". Click **Use these owners**: **Shares add up to 1** fails ("Shares add up to 1/2, not 1") and **Submit for review** is disabled. Add T 2210/2008 back with **+ Add** and use the owners again |
| With samples 01 and 02 also linked (real AI), remove **T 2210/2008** | **Chain of title** fails: "T 4521/2019 cites T 2210/2008, which is not in the record" |
| **Registered owners** → **Edit**: change an ID number to 10 digits and **Save owners** without a reason | "Give a reason for the values entered by hand: owner …". With a reason it saves, the owner shows **Entered by hand**, the check **ID numbers** fails, and **Values from the documents** warns |
| **New record** → **For a parcel**: Erf, number "2291", township "Eros", registration division "K" | "Erf 2291, Eros created": an empty draft. **Search** finds documents by deed number, party name or EDRMS number |
| **New record** for Erf 1873 again | "Could not create the record: Erf 1873, Klein Windhoek already has a land record (LR-NA-…)", and the existing record opens: one land record per parcel |
| **Comments** tab: write a note, **Post comment** (or Ctrl + Enter) | Your comment with your name, the time and the version it was written on |
| Click the eye on a document | The document opens in a new tab, at the version linked in the record |

## Common problems

| What happens | Why, and what to do |
|---|---|
| The sample documents do not appear under **Matching this parcel** | They are not filed yet (check Capture or Documents), or their property was read differently from "Erf 1873, Klein Windhoek". Use **Search** with the deed number |
| "Erf 1873, Klein Windhoek already has a land record" | One record per parcel. On a shared test system, another tester may have built it: open it from the list. If it is committed, use **Change record**, or ask the administrator to reset the test system |
| **Submit for review** stays disabled | Read **Record checks**: a missing link in the chain of title, an invalid ID number, shares that do not add up to 1, or an extent different from the SG diagram |
| "Could not save: The record is not complete yet …" when submitting | A required detail is missing, usually **Tenure**: set it in **Details** and submit again |
| "Not saved: The draft was changed by someone else" | Someone else edited the same draft. The record has been reloaded; do your change again |
| There is no **Withdraw from review** | Only the person who submitted the version can withdraw it |
| The task to approve your own record is not in your bell | Expected: a second person must approve it |

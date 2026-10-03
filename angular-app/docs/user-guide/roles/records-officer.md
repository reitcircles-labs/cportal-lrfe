# Records officer

*For testers and records-desk staff. Last checked against the app on 3 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The records officer builds the **land record** of a parcel (an erf or a farm) from its filed
documents: deeds of grant and transfer, survey diagrams, bonds. Linked in order, they form the
**chain of title**, from which the portal works out the registered owners and their shares. When the
record is complete and every check passes, the records officer **finalizes** it: that version becomes
the basis for tokenization and can only be superseded, never edited.

**You start on:** Land record. **Your menu:** Dashboard, Verify metadata (view only), Documents
(EDRMS), Land record, Process & schema.

| You can | You cannot |
|---|---|
| Create land records, link and remove documents, comment | Upload, review or file documents |
| Finalize a land record when its checks pass | Change a filed document (ask a reviewer for a correction) |

> **Demo screen.** The Land record screen still runs on demo data, with one live link: the
> documents of **Erf 1873, Klein Windhoek** count as filed once a reviewer has filed the matching
> sample documents through Verify. What you do here (new records, links, comments, finalizing) is
> kept only until you reload the page or sign out. Do each exercise in one sitting.

## The Land record screen

- **Land records** (left): every parcel, with filters (**All**, **Scanned**, **Ready for review**,
  **Finalized**), a search ("Erf, township or owner") and **New record**.
- **The record** (right): the erf, its status, registration division, extent, tenure and number of
  linked documents, with **Add documents** and **Finalize record**.
- Tabs: **Documents** (linked documents, and a panel to add more from the EDRMS), **Chain of title**
  (the transfers in date order), **Comments** (a discussion for reviewers, the registrar and
  auditors).
- Side panels: **Registered owners** (names, ID numbers, shares) and **Record checks** (what must be
  right before finalizing).

## Finalize Erf 1873 with the sample documents

**Before you start:** a reviewer has filed samples **03** (SG A 412/2007), **04** (T 2210/2008) and
**05** (T 4521/2019, with Tomas Nghishidi's ID corrected to 01112500379). See
[the whole flow](../testing-the-portal.md#the-whole-flow).

| # | Do | You should see |
|---|---|---|
| 1 | Sign in as the records officer | **Land record**, with **Erf 1873, Klein Windhoek** open. Two documents already linked: **G 88/1978** (deed of grant) and **T 1502/1996** (transfer to Johannes Shikongo), both **Filed**. Owner: Johannes Shikongo, 1/1. **Finalize record** is disabled |
| 2 | Click **Add documents** | The panel **Add documents from the EDRMS**, filter **Matching this parcel**: **T 2210/2008** (98%), **SG A 412/2007** (96%) and **T 4521/2019** (94%), each with the reason it matches and **+ Add** |
| 3 | **+ Add** on **T 2210/2008** | "T 2210/2008 added to Erf 1873". It appears under **Linked documents** with its real EDRMS number. Owners: **Petrus Nghishidi ½, Maria Nghishidi ½** |
| 4 | **+ Add** on **SG A 412/2007** | Linked; the check **Extent vs. SG diagram** turns ✓ |
| 5 | **+ Add** on **T 4521/2019** | Linked. Owners: **Maria Nghishidi ½, Ndapewa Nghishidi ¼, Tomas Nghishidi ¼** (Tomas with ID 01112500379) |
| 6 | Open the **Chain of title** tab | 1978 grant → 1996 → 2008 → 2019, each citing the previous title |
| 7 | Look at **Record checks** | **5 / 5**: Shares sum to one (½ + ¼ + ¼ = 1), Chain of title (T 1502/1996 → T 2210/2008 → T 4521/2019, each citing its prior title), Extent vs. SG diagram (1 214 m² both), Holder identity numbers (all valid 11-digit IDs), Open items (all documents resolved). **Finalize record** is enabled |
| 8 | Click **Finalize record** | "Finalize Erf 1873, Klein Windhoek?" listing "Registered owners: Maria Nghishidi ½, Ndapewa Nghishidi ¼, Tomas Nghishidi ¼" |
| 9 | Click **Finalize record** in that box | "Erf 1873 record v3 committed · Record is ready for tokenization." The record shows **Finalized** and "version 3" |

## Things to try on Erf 1873

Reload the page between exercises to start again from the demo state (the filed samples are found
again automatically).

| Do | You should see |
|---|---|
| Add **T 4521/2019** without **T 2210/2008** | **Chain of title** warns "T 4521/2019 cites T 2210/2008, which is not linked"; **Finalize record** stays disabled |
| On a matching document, click **Not this parcel** instead of **+ Add** | It is dismissed for this parcel and no longer counts as an open item |
| Remove a linked document with its ✕ | "… removed from Erf 1873 · The document is back in the unlinked pool"; owners and checks update; a finalized record goes back to not finalized |
| **Comments** tab: write a note, **Post comment** (or Ctrl + Enter) | Your comment with your name, role and time |
| Click the eye on a document | It opens in the document viewer |

If the reviewer filed sample 05 **without** correcting the ID number, **Holder identity numbers**
shows a warning and the record cannot be finalized: ask a reviewer to correct the filed document
(see the [reviewer guide](metadata-reviewer.md#correct-a-filed-document)), then reload.

## Create a new land record

| # | Do | You should see |
|---|---|---|
| 1 | **New record**: Erf / farm number "Erf 2291", Township "Eros", registration division, extent, tenure; **Create record** | "Land record created · Erf 2291, Eros · add documents to build the chain of title". Status **Draft**, 0 linked documents |
| 2 | **Add documents** → **All unlinked** | Demo documents of other parcels; the ones still **In review** cannot be added |
| 3 | **+ Add** one or two filed demo documents | Status **Verified · ready for review**; **Finalize record** becomes enabled once no check is in warning |

New records are demo only and disappear when you reload.

## Common problems

| What happens | Why, and what to do |
|---|---|
| The sample documents do not appear under **Add documents** | They are not filed yet (check Capture or Documents), or were filed under other numbers (a `--set` copy): the screen only knows the standard Erf 1873 set. Reload the page after they are filed |
| They appear as "In review" without **+ Add** | Not filed yet: the reviewer must file them first |
| **Finalize record** stays disabled | Read **Record checks**: a missing link in the chain of title, an invalid ID number, or a matching document neither added nor dismissed |
| My new record or links are gone | The Land record screen is a demo: reloading or signing out starts it again |

# Metadata reviewer

*For testers and review-desk staff. Last checked against the app on 3 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The metadata reviewer checks what the AI read from each scan against the scan itself, corrects what
is wrong, and **files** the document to the EDRMS, where it becomes a sealed document of record.
Documents that do not belong are **rejected**. Reviewers also request, and approve, corrections to
documents already filed.

**You start on:** Verify metadata. **Your menu:** Dashboard, Capture, Verify metadata, Documents
(EDRMS), Land record, Process & schema; and the **Tasks** bell for approvals.

| You can | You cannot |
|---|---|
| Accept, correct and add fields; re-read a document with the stronger AI model | Upload scans (Capture is view-only for you) |
| File documents to the EDRMS, or reject them with a reason | Approve your own correction request |
| Request a correction to a filed document, and approve other reviewers' requests | Finalize land records |

## The review screen

- **Review queue** (left): documents waiting, grouped by batch, with counters **Open**, **Need
  checks**, **Filed**, a search box ("Deed no., erf, file, batch") and the filters **Open / Filed /
  All**. Click a document to open it.
- **Opening a document reserves it for you**, so two reviewers never work on the same one. Anyone
  else who opens it sees "*Your name* is reviewing this document. You can look, but not change it."
  It is released when you move to another document or screen.
- **The scan** (middle): the PDF, and under it **AI transcription of page N**, the text the AI read.
- **Extracted metadata** (right): one row per field, with the value the AI read and a ✓ button
  (**Accept**). A field marked **· check** or **· conflict** needs your attention; click it to see
  the **evidence** (the words on the page the value came from) and the checks that flagged it.
  Required fields have a \*.
- Under the fields: what still blocks filing (e.g. "3 fields not reviewed yet"), **Accept N clean
  fields** and **Approve & file to EDRMS**.

## Review and file a document

Do this for samples **03** (SG diagram), **04** (T 2210/2008) and then **05** (see the next section
for its correction). The values the AI should have read are in
[the samples README](../../samples/README.md#what-the-ai-should-read).

| # | Do | You should see |
|---|---|---|
| 1 | Sign in as the reviewer. In the queue, find the batch the scan operator created, and click **T 2210/2008** | The document opens: "T 2210/2008 · Deed of transfer · Erf 1873, Klein Windhoek", the scan, and 17 fields, "0 of 17 reviewed" |
| 2 | Compare a few values with the scan: click **Consideration** | Its evidence, e.g. "sum of N$ 640 000,00", and the page shown beside it |
| 3 | Click **Accept N clean fields** | All fields the AI was sure of are accepted (✓ turns blue). Fields marked **· check** stay open |
| 4 | Click each remaining field and decide: if it is right, click its ✓; if it is wrong, type the right value in the box and press **Enter** | Accepted fields turn blue; a corrected field shows **· corrected** and "AI read '…'" |
| 5 | When nothing blocks filing, click **Approve & file to EDRMS** | "Filed as EDR-NA-2026-…": *the deed* "is now a sealed document of record". The next document opens |

Why a field is flagged, and what to do:

| Check | Means | Do |
|---|---|---|
| "Prior title T 1502/1996 is not in the EDRMS yet" | The deed it cites has not been filed (yet) | Check the number against the scan and accept. If sample 02 was filed first, this does not appear |
| "Diagram A 412/2007 is not in the EDRMS yet" | Same, for the SG diagram | Information only; file 03 before 04 and it disappears |
| "A Namibian ID number has 11 digits; this has 10" | The value cannot be a valid ID | Correct it from the scan (see sample 05) |
| "*T …* is already filed as EDR-NA-…" (**· conflict**) | This deed is already in the EDRMS | Do not file a duplicate: **Reject** it, reason "Duplicate of EDR-NA-…" |
| "May describe another party or item than this field asks for" | An automatic check thinks the value belongs to someone or something else in the document, e.g. the deceased's marital regime in the heirs' field | Read the scan: correct the value if it belongs to someone else, otherwise accept it |
| "Could not be confirmed in the document text" | The automatic check did not find this value for this field in the text | Compare with the scan; correct or accept |
| "The document text seems to contain this" (on an empty required field) | The value may be in the document after all | Look for it on the scan and type it in |

The automatic checks are switched on per system; where they are off, these three messages do not
appear. A document that could not be checked shows the note "Automatic cross-check unavailable for
this document" and is reviewed as usual.

## Correct a value before filing (sample 05)

Sample 05, deed T 4521/2019, contains a deliberate mistake: Tomas Nghishidi's ID number is typed
with 10 digits (0111250379), and a hand-written note in the margin gives the corrected number.

| # | Do | You should see |
|---|---|---|
| 1 | Open **T 4521/2019** | 17 or more fields, among them **Transferee 2 ID no.** |
| 2 | Click **Transferee 2 ID no.** | If the AI read 0111250379: the check "A Namibian ID number has 11 digits; this has 10", and filing is blocked ("Fix before filing: Transferee 2 ID no."). The scan shows the margin note "01112500379" |
| 3 | Type **01112500379** and press **Enter** | The field shows **· corrected**, "AI read '0111250379'", and the check disappears. (If the AI already read 01112500379 from the note, accept it.) |
| 4 | Accept the remaining fields, then **Approve & file to EDRMS** | "Filed as EDR-NA-…" |

> If you file the wrong number, the records officer cannot finalize Erf 1873 later: its owners would
> include an invalid ID number. That is intended.

## Reject a document

Sample **06** is a conveyancer's cover letter: not a registry instrument, it must not be filed.

| # | Do | You should see |
|---|---|---|
| 1 | Open the cover letter in the queue | Type "Other supporting document" (or not recognised) |
| 2 | Click **Reject** (top right) | "Reject …?" asking for a reason; the **Reject** button stays disabled until you type at least 3 characters |
| 3 | Type "Cover letter, not a registry instrument", click **Reject** | "… rejected". In the queue it moves out of **Open** (see it under **All**). The scan operator sees it as **Rejected** with your reason |

## Two reviewers on one document (try it)

With the second reviewer account in a private window:

| # | Who | Do | You should see |
|---|---|---|---|
| 1 | Reviewer | Open a document that is still in review | You can edit it |
| 2 | Second reviewer | Open the same document | "*Reviewer* is reviewing this document. You can look, but not change it."; fields and buttons disabled |
| 3 | Reviewer | Go to another screen, e.g. Documents | |
| 4 | Second reviewer | Reload the page | The banner is gone; they can edit |

## Correct a filed document

A filed document is sealed: it is never edited, but a correction can be added as a **new version**.
A different reviewer must approve it (four-eyes).

| # | Who | Do | You should see |
|---|---|---|---|
| 1 | Reviewer | **Documents (EDRMS)**: search for "T 2210/2008", click it | The record: EDRMS number, "v1.0", **Verified metadata**, **Version history**, **Record metadata (ISO 23081)** |
| 2 | Reviewer | **Request correction**: change one value (e.g. **Consideration** to N$ 650 000,00), give a reason of at least 5 characters, **Send for approval** | "1 field changed"; then the banner **Correction awaiting approval** ("A second person who can file documents must approve it") |
| 3 | Reviewer | Click the bell (**Tasks**) | Your own request is **not** there: you cannot approve it |
| 4 | Second reviewer (private window) | Bell → **Approve change to EDR-NA-… (T 2210/2008)** | The request: who asked, the reason, and a table Current → Proposed |
| 5 | Second reviewer | **Approve** (or **Reject**, which needs a comment) | "Change approved and applied". The document is now **v2.0**; its history shows "v2.0 · Amendment · Requested by … · approved by …" and the change, and v1.0 is kept |

Instead of waiting, the requester can **Withdraw** the request from the banner; the approval task then
disappears.

## Other tools

- **Re-read**: has the stronger AI model read the document again. It replaces the current fields,
  including those you already reviewed (the portal asks first). Use it when the first reading is poor.
- **Retry**: for a document whose reading **Failed**.
- **Add a field the AI did not find…** (under the fields): adds an empty field you can fill in.

## Common problems

| What happens | Why, and what to do |
|---|---|
| "Approve & file to EDRMS" stays disabled | Read the list above it: fields not reviewed yet, a field to fix, or a required field missing |
| "*T …* is already filed as EDR-NA-…" | Someone already filed this deed on this system. Reject the duplicate; for testing, see "Each deed can be filed once" in [the samples README](../../samples/README.md#things-to-know) |
| The queue is empty | Nothing is waiting: has the scan operator uploaded, and has the AI finished reading (Capture shows **In review**)? |
| "… is reviewing this document" | Another reviewer has it open; pick another, or wait until they move on |
| No approval task in the bell | The request was yours (you cannot approve it), it was withdrawn, or already decided |

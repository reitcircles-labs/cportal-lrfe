# Registrar (supervisor)

*For testers and registry supervisors. Last checked against the app on 6 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The registrar oversees the registry's work: follows capture and review, **approves land records**
that records officers submit, reviews audit evidence and manages the registry's users.

**You start on:** Dashboard. **Your menu:** Dashboard, Capture, Verify metadata, Documents (EDRMS),
Land record (create/finalize), Audit, and under Administration **Users** and **Access log**.

| You can | You cannot |
|---|---|
| See every screen of the land-record work | Upload, review, correct or file documents |
| Approve land records, or return them with a comment | Create land records, link documents or edit them (the records officer's job) |
| Check the integrity of filed documents; look at audit evidence | Sign off audits (the auditor's job) |
| Invite users, change their roles, suspend them | Change the permission matrix, offices or security policies (the system administrator's job) |

## Follow the work

| Do | You should see |
|---|---|
| **Dashboard** | Figures and recent activity (demo data for now) |
| **Capture**: pick a batch | Its documents and their status (Queued, Reading, In review, Filed, Rejected). The upload box is faded: you cannot upload |
| **Verify metadata**: open a document | The review screen, read-only: fields and buttons are disabled for you |
| **Documents (EDRMS)**: open a filed sample, **Check integrity** | "Integrity verified · version 1.0" (see the [auditor guide](auditor.md#check-a-documents-integrity)) |
| The bell (**Tasks**) | Land records waiting for your approval (corrections to filed documents are approved by reviewers, not by the registrar) |

## Approve or return a land record

**Before you start:** a records officer has submitted a record for review, e.g. Erf 1873 (see
[the records officer guide](records-officer.md#build-erf-1873-from-the-sample-documents)).

| # | Do | You should see |
|---|---|---|
| 1 | Click the bell | "Approve land record LR-NA-2026-… (Erf 1873, Klein Windhoek) version 1", labelled **Land record** |
| 2 | Click it | The review: **Submitted by** (the records officer), **Land record** (number, parcel, version), **Due**, then **Checks**, each with its result (shares add up to 1, the chain T 2210/2008 → T 4521/2019, extent matches A 412/2007, ID numbers valid, documents describe this parcel…), any values **Entered by hand** with the officer's reason, and **What this version contains**: the parcel fields, the three owners and the three documents |
| 3 | To return it: **Reject** without a comment | "Say what the records officer should fix." |
| 4 | Type a comment, e.g. "Add the zoning from the town planning scheme.", **Reject** | "Erf 1873, Klein Windhoek returned to the records officer". The officer sees your comment on the record |
| 5 | When it comes back, open the task again and **Approve** | "Erf 1873, Klein Windhoek approved: version 1 is now current". In **Land record**, the record now shows **Committed**, **Version 1**. (Before deciding, **Open record** in the review takes you to the record) |

A later change to the record arrives the same way, as version 2. The review then shows **Changes
since version 1**: each changed field with its old and new value, and any owners or documents added,
removed or updated.

You never get the task for a record **you** submitted: a second person must approve it. The person
who submitted can withdraw it before you decide; the task then disappears from your bell.

## Look at a land record

| Do | You should see |
|---|---|
| Open **Land record (create/finalize)**, point at **New record**, and on a draft record at **Add documents** (on a committed one, **Change record**) | Faded: "Requires …". Building records is the records officer's job |
| Open a record, **History** tab | Every approved version: who submitted it, who approved it, when, your comment if you left one, what it changed, and **Seal verified**; above them "Seal chain intact" |
| **Comments** tab | The discussion on the record; you can add to it |
| A record with status **Needs review** | One of its documents was corrected in the EDRMS: the banner says which and why. The records officer takes over the correction in a new version, which comes to you for approval |

## Look at audit evidence (demo)

**Audit** shows the evidence for Erf 1873: each document's provenance (what the AI read and what the
reviewer filed), integrity and trail. As registrar you can look and export; signing off is the
auditor's job ("Mark document audited" is faded for you). Details: [auditor guide](auditor.md#audit-a-land-record-demo).

## Manage users

The registrar can invite users into an office, change their roles and suspend them, exactly as an
administrator does: see [Inviting users and assigning roles](../inviting-users-and-assigning-roles.md).
The tabs **Offices**, **Roles & permissions** and **Security policies** are not shown to you.

## Common problems

| What happens | Why, and what to do |
|---|---|
| No land record task in the bell | Nothing is waiting: the officer has not submitted yet, withdrew it, or another person with the right to finalize approved it already. Click the bell to refresh |
| "You cannot act on this task: a different person must do it (four-eyes)" | You submitted this version yourself (possible with an account that has both roles): someone else must approve it |
| The review shows a check that fails | It cannot happen for a fresh submission (the officer cannot submit then), but a correction filed in the EDRMS while you review is shown on the record as **Needs review**: return it so the officer takes the newer document over |
| The review screen for documents is read-only | Expected: reviewing documents is the metadata reviewer's job |

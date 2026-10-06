# Land records app: documentation

Material for the user documentation of the Deeds Registry land records app. Each guide is written
for someone using the app for the first time; no technical background is needed unless a guide
says so.

| Guide | For | What it covers |
|---|---|---|
| [Testing the portal: start here](user-guide/testing-the-portal.md) | Testers | What you need, test accounts, signing in, which screens are live and which are demo, the whole flow across the roles, reporting a problem |
| [Scan operator](user-guide/roles/scan-operator.md) | Scan station | Creating batches, uploading scans, following each document until filed or rejected |
| [Metadata reviewer](user-guide/roles/metadata-reviewer.md) | Review desk | Checking and correcting what the AI read, filing to the EDRMS, rejecting, correcting a filed document with a second reviewer's approval |
| [Records officer](user-guide/roles/records-officer.md) | Records desk | Building a parcel's land record from its filed documents, submitting it for review, changing it later, taking over corrected documents |
| [Registrar (supervisor)](user-guide/roles/registrar.md) | Registry supervisors | Following the work, approving or returning land records, audit evidence, managing users |
| [Auditor · read-only](user-guide/roles/auditor.md) | Office of the Auditor-General | Checking filed documents' integrity, a land record's history and seals, auditing a land record |
| [System administrator](user-guide/roles/system-administrator.md) | ICT | Test accounts, offices, the permission matrix, security policies, the access log |
| [Inviting users and assigning roles](user-guide/inviting-users-and-assigning-roles.md) | Administrators | Inviting someone by email, what they do to activate their account, the six roles, changing roles, suspending, and a step-by-step check that it all works |

**Sample documents** for testing are in [samples/](samples/README.md): the fictitious chain of title
of Erf 1873, Klein Windhoek (deeds, an SG diagram, an estate transfer with an ID number to correct)
and a cover letter to practise rejecting, with the values the AI should read from each.

Technical setup (servers, email, ports) is documented with the backend: `backend/README.md` and
`backend/services/identity/README.md`.

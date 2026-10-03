# System administrator

*For testers and ICT staff. Last checked against the app on 3 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The system administrator looks after who can use the portal and how: offices, users, roles, the
permission matrix and security policies, and the access log. The administrator has **no rights
over land-record work**: they cannot upload, review, file or finalize anything.

**You start on:** Users. **Your menu:** Dashboard, Documents (EDRMS), Audit, and under
Administration **Users**, **Offices**, **Roles & permissions**, **Security policies**, **Access log**.

| You can | You cannot |
|---|---|
| Add, edit, suspend and reactivate offices | Upload, review, file or correct documents |
| Invite users, change their roles and office, suspend them, reset their MFA | Create or finalize land records |
| Change what each role may do; set security policies | Change your own roles or status |
| Read the access log | Leave the system without an administrator (the portal refuses) |

Inviting users, roles, suspension and MFA resets are explained step by step in
[Inviting users and assigning roles](../inviting-users-and-assigning-roles.md). This guide covers the
rest and the test accounts testers need.

## Prepare test accounts

Testers need one account per role ([Test accounts](../testing-the-portal.md#test-accounts)):

| # | Do | You should see |
|---|---|---|
| 1 | **Users → Invite user**: the tester's name, a plus address (e.g. `tester+scan@your-domain`), office **WDH · Deeds Registry · Windhoek**, role **Scan operator**; **Create invitation** | "Invitation sent to …"; the user listed as **Invited** |
| 2 | Repeat for Metadata reviewer (twice: the second approves corrections), Records officer, Registrar, Auditor | One invited user per role |
| 3 | After the tester activates each account | Status **Active**, MFA ✓ |

The invite dialog's **Role** list starts on "Metadata reviewer": check it before creating the
invitation.

## Offices

| # | Do | You should see |
|---|---|---|
| 1 | **Offices** | The deeds offices, e.g. **WDH** Deeds Registry · Windhoek and **REH** Deeds Registry · Rehoboth, with their type, number of users and status |
| 2 | **Add office**: a code of 2 to 5 capital letters (e.g. **OAG**), type **External body**, name "Office of the Auditor-General", address; **Add office** | "Office OAG added". The code is permanent: it appears in batch and document numbers |
| 3 | Click the office, change the contact, **Save** | "Office OAG saved". The code cannot be edited |
| 4 | Click it again, **Suspend office**, confirm | Status **Suspended**: no new invitations into it; its users carry on working |
| 5 | **Reactivate office** | Active again |

Offices are never deleted.

## Roles and the permission matrix

**Roles & permissions** shows the six roles as cards and a matrix of permissions × roles.

| # | Do | You should see |
|---|---|---|
| 1 | Tick or untick a box, e.g. give **Auditor · read-only** the permission **Comment on records** | "1 unsaved permission change" at the bottom. Cells that would break a duty rule are highlighted |
| 2 | **Save changes**, confirm | "Permission matrix saved". Users with that role get it at their next sign-in, or within 15 minutes |
| 3 | Untick it again and save | Back to the standard set |

Some boxes are locked so that the portal always keeps an administrator.

## Security policies

| Policy | Default | Effect |
|---|---|---|
| Require multi-factor authentication | On | Every sign-in needs a code from the authenticator app |
| Allow sign-in with national eID | On | Not connected yet |
| Restrict to government network | Off | Not enforced yet |
| Idle session timeout | 30 min | Users are signed out after this long without activity |
| Four-eyes finalization | On | The officer who finalizes a land record must differ from the reviewer who filed its documents |
| Segregation of duties | 3 of 4 rules on | Pairs of permissions no one should hold together; each shows how many users are affected |

Change a policy, then **Save policies** and confirm: "Security policies saved". Enabling a duty rule
that users already break records them in the access log as accepted exceptions.

## Check the access log

**Access log** lists every sign-in, failed sign-in, denied action, invitation, role, office and
policy change, with who, what, the target and details. Filter by kind (**Roles**, **Users**,
**Offices**, **Policies**, **Denied**, **Sign-ins**) and search by name.

After testers have run [the whole flow](../testing-the-portal.md#the-whole-flow), you should find:
their sign-ins and MFA enrolments; any "Access denied" for actions their role does not allow; and
your own changes. A role change that breaks a duty rule says so, e.g. "+ Auditor · read-only · duty
conflict accepted: Reviewers cannot audit documents they can file".

## Common problems

| What happens | Why, and what to do |
|---|---|
| "This change would leave no active user able to manage roles & permissions" | The portal always keeps one active administrator |
| **Invite user** is disabled | There is no active office: add or reactivate one first |
| The invitation email was not sent | The message gives the reason; see the identity README (Email → troubleshooting), then **Resend invite** |
| A suspended user still sees the portal | They are refused at their next click and sent to sign-in |

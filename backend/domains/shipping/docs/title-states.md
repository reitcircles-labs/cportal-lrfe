# B/L title states and commands (CB-30, CB-38, CB-36)

The title engine, `@lrfe/domain-shipping/title` (`src/title/`), says what state a bill of
lading's title is in, which commands may run on it, and who may run them. It is pure code: it
stores nothing and checks no registration; the shipping record service (CB-31 onwards) keeps the
titles, signs each step into the [chain of title](chain-of-title.md) and calls it.

The rules live in one table, `TITLE_COMMANDS` (`src/title/table.js`); `applyTitleCommand` and
`allowedCommands` both work from it. Every refusal text is in `TITLE_WORDING`
(`src/title/wording.js`).

## Kinds

| Kind | DCSA document | Holder |
|---|---|---|
| `negotiable` | `transportDocumentTypeCode` `BOL`, `isToOrder` true | yes: moves by endorsement |
| `straight` | `BOL`, `isToOrder` false | none |
| `waybill` | `SWB` (a sea waybill) | none |

`kindOf(document)` reads the kind of a DCSA document.

## A title

`{kind, state, carrier, holder, endorsement, consignee, returnTo}`

- `carrier`: the organisation that issued the B/L.
- `holder`: the organisation holding a negotiable B/L, or null. Straight B/Ls and sea waybills
  never have one.
- `endorsement`: `none` (not endorsed yet), `named` or `blank`.
- `consignee`: the consignee's organisation of a straight B/L or sea waybill, or null.
- `returnTo`: while the carrier holds a B/L for an amendment or a split, whom it goes back to.

## States

| Kind | State | Holder | End |
|---|---|---|---|
| negotiable | `issued` | the shipper; nothing endorsed yet | |
| negotiable | `with-holder` | the holder | |
| negotiable | `surrendered` | the carrier | |
| negotiable | `amendment-requested` | the carrier, remembering `returnTo` | |
| negotiable | `accomplished` | none | yes |
| negotiable | `void` | none | yes |
| negotiable | `switched-to-paper` | none | yes |
| negotiable | `split` | none (the children are new B/Ls) | yes |
| straight, waybill | `issued` | none | |
| straight, waybill | `delivered` | none | yes |
| straight, waybill | `void` | none | yes |

## Commands

`applyTitleCommand(title, command, actor, {modules})`: `title` is null before issue, `command` is
`{name, ...arguments}`, `actor` is `{organisation}`, `modules` the modules on (below; all when not
given). It gives `{title}` (a split also gives `children`) or throws a `TitleRefusal` with a
stable `code` and a reason for people. `allowedCommands(title, actor, {modules})` lists the
commands that organisation may run now (arguments aside: `endorse` is listed when it may endorse
to a name).

| Command | Arguments | Kinds | From | Who | Leads to |
|---|---|---|---|---|---|
| `issue` | `kind`, `shipper`, `consignee?` | all | before issue | any organisation; it becomes the carrier | `issued`; negotiable: holder = shipper (required); others: consignee recorded |
| `void` | | all | `issued` | carrier | `void` |
| `endorse` | `to`, `inBlank` | negotiable | `issued`, `with-holder` | holder | `with-holder`, holder = `to`, endorsement `blank` or `named` |
| `transfer` | `to` | negotiable, endorsed in blank | `issued`, `with-holder` | holder | `with-holder`, holder = `to` |
| `surrender` | | negotiable | `issued`, `with-holder` | holder | `surrendered`, holder = carrier |
| `release` | | negotiable | `surrendered` | carrier | `accomplished`, no holder |
| `deliver` | | straight, waybill | `issued` | carrier | `delivered` |
| `surrender-for-amendment` | | negotiable | `issued`, `with-holder` | holder | `amendment-requested`, holder = carrier, `returnTo` = the holder |
| `amend` | | negotiable | `amendment-requested` | carrier | `with-holder`, holder = `returnTo` |
| `split` | `children` (≥ 2) | negotiable | `amendment-requested` | carrier | `split`; each child: negotiable, `with-holder`, held by `returnTo`, endorsed as the parent, same carrier |
| `switch-to-paper` | `confirmBearer?` | negotiable | `issued`, `with-holder` | holder | `switched-to-paper`, no holder |

The endorsement is kept through surrender, amendment and release. The new document version of an
amendment, and the children's documents of a split, are the service's business (CB-35, the
shipping record service's README):

- **Amend** commits the carrier's new document as the B/L's next version (same carrier code and
  reference, still to order, checked like any document), committed by the engine: the holder's
  surrender for amendment is the authority, so there is no four-eyes review. The holder, the
  endorsement and the chain are kept; the `amend` entry names the new version's hash. Refused
  (`draft-open`, 409) while a version of the B/L is being drafted or in review.
- **Split** closes the parent (`split`) and makes each child a new B/L of the carrier, version 1
  committed by the engine, whose first entry `issue-from-split` follows the parent's `split`
  entry. The children's cargo adds up to the parent's: together they name exactly the parent's
  containers (one may be named by several children when its cargo is divided), and per container
  their packages and gross weights add up (`splitCargoProblems`, `src/bill-of-lading/cargo.js`).
  Their ports of discharge, and every other field, may differ. Refused (`draft-open`, 409) while
  a version of the parent is being drafted or in review, as an amendment is.
- **No partial release.** A B/L is released whole, from `surrendered`: a `release` naming part of
  its cargo (`containers`, `equipmentReferences`, `cargoItems`, `consignmentItems`, `part`,
  `quantity`: `CARGO_PART_ARGUMENTS`) is refused `partial-release`. To release part of a cargo,
  the B/L is split first and the child carrying it released; the others stay open.

## Modules (CB-38)

An install switches parts of the engine on with `LRFE_BL_MODULES`: module names, comma-separated.
Not set or blank: every module. `waybill` is always on, listed or not. The module of each command,
and for `issue`, `void` and `endorse` of each case, is in `TITLE_COMMANDS` (`module`,
`moduleOfKind`, `moduleInBlank`); `MODULES` (`src/title/modules.js`) lists each module's name,
label, needs and commands.

| Module | Label | Needs | Commands |
|---|---|---|---|
| `waybill` | Sea waybills and straight B/Ls | (always on) | `issue` of a sea waybill or straight B/L, `deliver`, `void` of a sea waybill or straight B/L |
| `negotiable` | Negotiable B/Ls | | `issue` of a B/L to order, `endorse` to a name, `surrender`, `release`, `switch-to-paper`, `void` of a negotiable B/L |
| `blank-endorsement` | Blank endorsement | `negotiable` | `endorse` with `inBlank` true, `transfer` |
| `amendment` | Amendment | `negotiable` | `surrender-for-amendment`, `amend` |
| `split` | Split | `amendment` | `split` |

- **A command of a module that is off is refused** (`module-off`) before any other rule but an
  unknown command, and `allowedCommands` leaves it out. The reason names the most basic module
  that is off: a split while negotiable B/Ls are off says "Negotiable B/Ls are not enabled on this
  platform".
- **`void` of a negotiable B/L belongs to `negotiable`**: it is the carrier's cancel before the
  B/L has moved, available whenever negotiable B/Ls are.
- **Stored data never depends on the setting:** no field of a title changes with it. Turning a
  module off only refuses that module's new commands: a B/L made while it was on stays as it is
  and readable, and goes on with the commands of the modules still on (a blank-endorsed B/L can
  still be endorsed to a name with blank endorsement off).
- **Turn a module off only when no B/L is in the middle of it.** A B/L waits wherever only that
  module's commands could move it on: one in `amendment-requested` stays there while
  `amendment` is off, and a negotiable B/L with a holder can neither move nor be surrendered
  while `negotiable` is off. Nothing is lost: turning the module on again lets it go on.
- `modulesFromSettings(source = process.env)` reads the setting. An unknown name, an empty name in
  the list, or a module without the one it needs (e.g. `blank-endorsement` without `negotiable`,
  `split` without `amendment`) stops the start with a message naming it and the known modules.
  The shipping record service reads it at start and runs the engine with it.

## Refusals

Checked in this order; the first rule broken is the reason.

| Code | When | Example reason |
|---|---|---|
| `unknown-command` | no such command | Unknown command: burn |
| `module-off` | the command's module is off in this install | Negotiable B/Ls are not enabled on this platform |
| `not-issued` | a command other than `issue` before issue | This B/L has not been issued yet: it can only be issued |
| `already-issued` | `issue` on an issued B/L | This B/L is already issued |
| `no-organisation` | no acting organisation | The command needs the organisation that runs it |
| `wrong-kind` | the kind has no such command | A sea waybill has no holder: it cannot be endorsed |
| `closed` | an end state | This B/L is accomplished: nothing more can be done with it |
| `wrong-state` | not from this state | This B/L cannot be voided while it is with its holder |
| `not-carrier` | a carrier's command by another organisation | Only the carrier that issued this B/L may release it |
| `not-holder` | a holder's command by another organisation | Only the current holder may endorse this B/L |
| `not-endorsed-in-blank` | `transfer` of a B/L not endorsed in blank | A B/L endorsed to a named organisation moves only by endorsement, not by transfer |
| `unknown-kind` | `issue` with an unknown kind | Unknown kind of B/L: … |
| `missing-shipper` | negotiable `issue` without a shipper | A negotiable B/L needs the organisation of its shipper, its first holder |
| `missing-recipient` | `endorse`/`transfer` without `to` | Name the organisation that is to receive the B/L |
| `same-holder` | `to` is the holder already | This B/L is already held by that organisation |
| `invalid-argument` | `endorse` without a boolean `inBlank` | Say whether the B/L is endorsed in blank or to the named organisation |
| `too-few-children` | `split` into fewer than two | A split needs at least two new B/Ls |
| `partial-release` | `release` naming part of the cargo | A B/L is released whole: to release part of its cargo, split it into new B/Ls first |
| `bearer-unconfirmed` | `switch-to-paper` of a blank-endorsed B/L without `confirmBearer` | Switching a blank-endorsed B/L to paper makes it a bearer document: confirm it to go on |

### Refusals of the shipping record service

The service runs the engine (above) and refuses some commands itself, before or after it: its
code is in the answer's `details.code`, and a refusal records nothing. The engine's refusals are
answered 403 (`no-organisation`, `not-carrier`, `not-holder`), 400 (`unknown-command`,
`unknown-kind`, `missing-shipper`, `missing-recipient`, `invalid-argument`, `too-few-children`,
`partial-release`) or 409 (the others). An organisation that may not see the B/L gets 404 "B/L not
found" before any refusal that would tell the B/L's state.

| Code | Status | When | Example reason |
|---|---|---|---|
| `unknown-command` | 400 | `POST /records/:id/title/<name>` with a name the service does not offer | Unknown command: burn |
| `not-committed` | 409 | `issue` of a B/L with no committed version | This B/L has no committed version yet: it can be issued once a version is committed |
| `in-review` | 409 | `issue` while a new version is in review | A new version of this B/L is in review: it can be issued once the review is decided |
| `unregistered-organisation` | 422 | the shipper on `issue`, or `to` on `endorse`/`transfer`, is not a registered and active organisation | (the organisation and why) |
| `organisations-unavailable` | 503 | the organisations cannot be checked now | The organisations cannot be checked now: try again later. |
| `changed-meanwhile` | 409 | another command changed the title since it was read (of two at the same moment, one wins) | This B/L changed meanwhile: read it again |
| `not-set-up` | 503 | the platform has no signing key (production without `TITLE_SIGNER`) | Title commands are not available yet: the platform signature is not set up. Tell the administrator. |
| `draft-open` | 409 | `amend` or `split` while a version of the B/L is being drafted or in review | A new version of this B/L is being drafted or in review: finish or discard that draft before amending or splitting the B/L |
| `missing-document` | 400 | `amend`, or a child of `split`, without a document | Send the new document of the B/L with its format |
| `different-reference` | 400 | the new document changes the carrier code or the reference (`amend`), or a child's carrier code (`split`) | The new document must keep the carrier code and the transport document reference of this B/L |
| `kind-changed` | 400 | the new document, or a child, is not a B/L to order | The new document must stay a negotiable B/L (a B/L to order): its kind cannot change |
| `child-reference` | 400 | two children of a split, or a child and the parent, share a reference | Each new B/L needs its own transport document reference: … is used twice |
| `cargo-mismatch` | 400 | the children's cargo does not add up to the parent's (`details.problems`) | The cargo of the new B/Ls must add up to the B/L's: … |
| `reference-taken` | 409 | the carrier already has a B/L with a child's reference | The carrier already has a B/L with the reference … |
| `proof-unavailable` | 503 | `GET /records/:id/title/proof` while the proof on the blockchain cannot be read | The proof on the blockchain cannot be read now: try again later. |

An invalid document (`amend`, `split`) is refused 400 with every problem in `details.problems`,
as when a B/L is drafted.

## Permissions

Through the service (`POST /records/:id/title/:command`), each command needs a permission of the
shipping pack, and the organisation of the session runs it (never one named in the request). The
engine then checks that this organisation is the carrier or the holder the command needs (`Who`
in the commands table). `bl.issue` is for the carrier's staff, `bl.endorse` for the holder's; the demo role `bld` has both. Reading a title and its proof
needs `bl.read`, by the carrier, a current or past holder or the consignee.

| Command | Permission |
|---|---|
| `issue` | `bl.issue` |
| `void` | `bl.issue` |
| `release` | `bl.issue` |
| `deliver` | `bl.issue` |
| `amend` | `bl.issue` |
| `split` | `bl.issue` |
| `endorse` | `bl.endorse` |
| `transfer` | `bl.endorse` |
| `surrender` | `bl.endorse` |
| `surrender-for-amendment` | `bl.endorse` |
| `switch-to-paper` | `bl.endorse` |

`issue-from-split` is not a command: it is the first chain entry of a B/L made by a split, written
by the split ([chain of title](chain-of-title.md)).

## Decisions

- **A straight B/L works like a sea waybill:** no holder, no endorsement; the carrier delivers it
  to the consignee.
- **Blank endorsement is allowed**, and a holder of a blank-endorsed B/L may endorse it to a name.
  Possession still moves only between registered organisations: that is the service's check
  (CB-34, CB-37), not the engine's.
- **The endorsee is not written into the stored document at endorsement:** the chain of title
  records it, and the DCSA converter adds it when a B/L is written out (CB-37, built:
  `endorseeOf` and `fromModel`'s `endorsee`, see [chain of title](chain-of-title.md), "The
  endorsee written out").
- **A B/L can be voided only while still with the shipper**, never once it has been endorsed or
  transferred.
- **Switching a blank-endorsed B/L to paper needs a confirmation**, because the paper becomes a
  bearer document.

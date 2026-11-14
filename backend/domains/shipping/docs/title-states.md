# B/L title states and commands (CB-30)

The title engine, `@lrfe/domain-shipping/title` (`src/title/`), says what state a bill of
lading's title is in, which commands may run on it, and who may run them. It is pure code: it
stores nothing and checks no registration; the shipping record service (CB-34 onwards) keeps the
titles and calls it.

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

`applyTitleCommand(title, command, actor)`: `title` is null before issue, `command` is
`{name, ...arguments}`, `actor` is `{organisation}`. It gives `{title}` (a split also gives
`children`) or throws a `TitleRefusal` with a stable `code` and a reason for people.
`allowedCommands(title, actor)` lists the commands that organisation may run now.

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
amendment, and the children's documents of a split, are the service's business (CB-35).

## Refusals

Checked in this order; the first rule broken is the reason.

| Code | When | Example reason |
|---|---|---|
| `unknown-command` | no such command | Unknown command: burn |
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
| `bearer-unconfirmed` | `switch-to-paper` of a blank-endorsed B/L without `confirmBearer` | Switching a blank-endorsed B/L to paper makes it a bearer document: confirm it to go on |

## Decisions

- **A straight B/L works like a sea waybill:** no holder, no endorsement; the carrier delivers it
  to the consignee.
- **Blank endorsement is allowed**, and a holder of a blank-endorsed B/L may endorse it to a name.
  Possession still moves only between registered organisations: that is the service's check
  (CB-34, CB-37), not the engine's.
- **The endorsee is not written into the stored document at endorsement:** the chain of title
  records it, and the DCSA converter adds it when a B/L is written out (CB-37).
- **A B/L can be voided only while still with the shipper**, never once it has been endorsed or
  transferred.
- **Switching a blank-endorsed B/L to paper needs a confirmation**, because the paper becomes a
  bearer document.

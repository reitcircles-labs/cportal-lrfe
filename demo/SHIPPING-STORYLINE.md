# Shipping demo storyline (R1: one negotiable B/L; CB-48)

The script for whoever gives the demo of the shipping product (electronic bills of lading): who to sign in as, what to
click, what to say, and what the audience should notice. One negotiable B/L ("to order") travels the whole journey of
the CB-9 personas map: the carrier issues it to the shipper, the shipper endorses it to its bank, that bank to the
buyer's bank, that bank to the buyer; the buyer surrenders it, the carrier releases the goods, and a bank checks the
B/L and its proof for itself. Good weather only: no refusals, amendments or splits. It takes about 30 minutes.

Every step below is also followed, click for click, by the end-to-end test `e2e/tests-shipping/demo-storyline.spec.ts`
on a fresh shipping stack, with only the demo users and the screens (screenshots: `npm run evidence -- CB-48
--shipping` in `e2e/`).

## Before you start

- **A fresh shipping install** (`LRFE_DOMAIN=shipping`, `shipping` in `COMPOSE_PROFILES`, `SEED_DEMO_PASSWORD` set,
  the title signer prepared: `deploy/README.md`, part D, step 7) that passed the readiness check
  (`node demo/check-readiness.mjs`, see [README.md](README.md), "A shipping install"). It lists the seven demo users
  below. Do not rehearse on the install you will show: B/L numbers are unique, and the B/L of a rehearsal stays in
  everyone's list.
- **Your phone** has the authenticator app, and you know the demo password (`grep SEED_DEMO_PASSWORD deploy/.env`). It
  is never written in this document. Each demo user sets up the authenticator at their first sign-in; do that once for
  all seven before the demo (README.md, "A shipping install"), so that the demo itself only needs the 6-digit codes.
- **Anchoring is on** (README.md, "Anchoring for the demo"), with `ANCHOR_PERIOD=5m`: the check at the end shows the
  proof confirmed on the blockchain only once the batch after the release is out.
- **The portal is open** in a normal browser window at full screen.

### The cast

The organisations and people are made up (the ports and the place of issue are real, for a plausible voyage). They are created on a fresh install with the demo
password (`backend/domains/shipping/src/identity.js`).

| Act | Sign in as | Organisation | Role | What they do |
|---|---|---|---|---|
| 1 | `a.morgan@shipping.example`, Alex Morgan | Shipping Registry (the platform operator) | System administrator | Shows the organisations on the platform |
| 2 | `l.okafor@bluewater-lines.example`, Lena Okafor | Bluewater Meridian Lines (carrier, code BWML) | B/L documentation (carrier) | Drafts the B/L, submits it |
| 3, 8 | `r.menon@bluewater-lines.example`, Ravi Menon | Bluewater Meridian Lines | B/L documentation (carrier) | Approves and issues it; releases the goods |
| 4 | `a.ribeiro@highland-coffee.example`, Ana Ribeiro | Highland Coffee Exporters (shipper) | B/L trade | Endorses it to her bank |
| 5 | `g.mensah@harbour-trust.example`, Grace Mensah | Harbour Trust Bank (exporter's bank) | B/L trade | Endorses it to the buyer's bank |
| 6, 9 | `m.tanaka@northgate-bank.example`, Mei Tanaka | Northgate Commercial Bank (buyer's bank) | B/L trade | Endorses it to the buyer; checks the B/L and its proof |
| 7 | `y.demir@roastery-collective.example`, Yusuf Demir | Roastery Collective Imports (buyer) | B/L trade | Surrenders it to the carrier |

### Switching people

1. Top right, **Sign out**.
2. On **Sign in**: the next person's email, the demo password, **Sign in**.
3. **Enter your code**: the 6-digit code from the phone for that person, **Verify and sign in**.

*Say, the first time:* "Every person has their own account, in their own company. What they see and may do depends on
their company's part in the B/L, not on who they are: watch the buttons change as the B/L moves."

### What the audience should notice, all along

- **One holder at a time.** The B/L page always names exactly one holder. Only the holder's people get the buttons that
  move it; the moment they endorse it, they become a past holder and the buttons are gone.
- **The chain of title.** Every step (issued, each endorsement, surrendered, released) is a row on the B/L page, with
  who it went from and to, and when. Nobody can remove or reorder a row.
- **The proof that verifies offline.** At the end, a bank checks the whole chain in its own browser, downloads the
  proof file and can verify it without trusting the platform: the platform's signature on every step, and the
  blockchain record of the last one.

## Act 1 · The platform operator: the organisations (2 min)

Sign in as **`a.morgan@shipping.example`**. He lands on **Organisations**.

| # | Do | They see |
|---|---|---|
| 1.1 | Nothing: the list is open | The five organisations of the demo, each with its code: Bluewater Meridian Lines (BWML), Highland Coffee Exporters (HCEX), Harbour Trust Bank (HTB), Northgate Commercial Bank (NGCB), Roastery Collective Imports (RCI), and the operator's own, Shipping Registry |

*Say:* "The platform is run by a neutral operator. It admits companies and their staff, and that is all it can do: it
has no button to move a B/L, not even in a dispute."

## Act 2 · The carrier's clerk: the draft (5 min)

Sign in as **`l.okafor@bluewater-lines.example`**. She lands on **Bills of lading**.

| # | Do | They see |
|---|---|---|
| 2.1 | **New B/L** | The form: "A draft of Bluewater Meridian Lines. A second person approves it before it is issued." |
| 2.2 | Fill in: **B/L number** in the carrier's form: its code, the year and month, a running number of any length, e.g. `BWML2611001` (each B/L number once per install), **Carrier code** `BWML`, **Booking reference** `BKG-2611-0042`; **To order**: *Yes, negotiable* (already chosen); **Shipper**: *Highland Coffee Exporters*; place of issue **Street** `Rua do Porto 12`, **City** `Santos`, **Country code** `BR`; **Vessel** `Meridian Star`, **Voyage** `2611E`, **Port of loading** `BRSSZ`, **Port of discharge** `NLRTM`, **Planned departure** and **Planned arrival** two dates apart; **Container number** `BWMU7045123`, **Container type** `22G1` (filled in: a 20-foot dry container; keep it), **Seal number** `SL220871`, **Goods** `320 bags of green coffee beans`, **HS code** `090111`, **Number of packages** `320`, **Kind of packages** `Bags`, **Gross weight (kg)** `19200`; **The carrier's terms** come filled in with the carrier's standard text: leave them | The shipper is picked from the companies on the platform, not typed; the platform operator is not among them |
| 2.3 | **Save draft** | The B/L's page, "B/L BWML2611001 (BWML)", State *Draft*, Kind *Negotiable B/L* |
| 2.4 | **Submit for approval** | State *In review*; under **Approval**: "You prepared this draft, so a second person must approve it." No **Approve** button |

*Say:* "Four eyes: the person who drafts a B/L can never issue it alone. The platform refuses it, not just the screen."

## Act 3 · The carrier's release manager: approve and issue (3 min)

Sign in as **`r.menon@bluewater-lines.example`**. Open the B/L from the list (**Open B/L BWML2611001 (BWML)**).

| # | Do | They see |
|---|---|---|
| 3.1 | Read **Approval** | "Waiting for your approval", prepared by Lena Okafor, the shipper Highland Coffee Exporters |
| 3.2 | **Approve** | State *Ready to issue*; "Approved by Ravi Menon: ready to issue." |
| 3.3 | **Issue to the shipper** | State *Issued*; **Holder** Highland Coffee Exporters; **Chain of title**: one row, *Issued*; Consignee "None: to order" |

*Point out:* the holder. "From now on, whoever holds this B/L controls the goods. Right now that is the shipper, and
only the shipper can pass it on. Not the carrier, not the operator."

## Act 4 · The shipper: endorse to its bank (3 min)

Sign in as **`a.ribeiro@highland-coffee.example`**. Her list shows the B/L, her role **Holder**.

| # | Do | They see |
|---|---|---|
| 4.1 | Open the B/L, **Endorse to…** | A panel **Endorse to a named organisation**, with the list **Endorse to**: "Organisations registered on the platform."; neither her own company nor the platform operator is offered |
| 4.2 | Choose **Harbour Trust Bank** | Under the choice: "Harbour Trust Bank becomes the holder; you can no longer act on this B/L." |
| 4.3 | **Endorse** | The confirmation: "Endorse B/L BWML2611001 (BWML) to Harbour Trust Bank?", with the same sentence |
| 4.4 | **Endorse** (in the confirmation) | State *With holder*; **Holder** Harbour Trust Bank; **Your role** *Past holder*; no more **Endorse to…**; the chain has a second row, *Endorsed*, from Highland Coffee Exporters to Harbour Trust Bank |

*Say:* "The shipper is paid by its bank against this B/L, so it hands the B/L over. One click, and it is no longer
hers: there is no copy left behind that still counts."

## Act 5 · The exporter's bank: endorse to the buyer's bank (2 min)

Sign in as **`g.mensah@harbour-trust.example`**. Open the B/L (her role: **Holder**).

| # | Do | They see |
|---|---|---|
| 5.1 | **Endorse to…**, choose **Northgate Commercial Bank**, **Endorse**, and **Endorse** in the confirmation | **Holder** Northgate Commercial Bank; the chain's third row; Grace's company is now a past holder |

## Act 6 · The buyer's bank: endorse to the buyer (2 min)

Sign in as **`m.tanaka@northgate-bank.example`**. Open the B/L.

| # | Do | They see |
|---|---|---|
| 6.1 | **Endorse to…**, choose **Roastery Collective Imports**, **Endorse**, and **Endorse** in the confirmation | **Holder** Roastery Collective Imports; the chain's fourth row |

*Say:* "The buyer has paid its bank; the bank passes the title on. Each bank only ever saw one holder at a time, and
every hand-over is on the chain."

## Act 7 · The buyer: surrender to the carrier (2 min)

Sign in as **`y.demir@roastery-collective.example`**. Open the B/L (his role: **Holder**).

| # | Do | They see |
|---|---|---|
| 7.1 | **Surrender to the carrier** | "Surrender B/L BWML2611001 (BWML) to the carrier?": the carrier will hold it to release the goods; he can no longer endorse it |
| 7.2 | **Surrender** | State *Surrendered*; **Holder** Bluewater Meridian Lines; his role *Past holder*; the chain's fifth row |

*Say:* "The ship has arrived. The buyer gives the B/L back to the carrier to claim the goods, exactly what a paper
original is for."

## Act 8 · The carrier: release the goods (2 min)

Sign in as **`r.menon@bluewater-lines.example`**. Open the B/L (State *Surrendered*).

| # | Do | They see |
|---|---|---|
| 8.1 | **Release the goods** | "Release the goods of B/L BWML2611001 (BWML)?": the B/L becomes accomplished, nobody holds it any more |
| 8.2 | **Release** | State *Accomplished*; no holder; no buttons left; the chain complete: six rows, the last *Released* |

## Act 9 · The buyer's bank: check the B/L and its proof (5 min)

Wait until the anchoring batch after the release is out (up to `ANCHOR_PERIOD`, 5 minutes on the demo install; fill
the time with questions). Sign in as **`m.tanaka@northgate-bank.example`**. Open the B/L (her role: past holder).

| # | Do | They see |
|---|---|---|
| 9.1 | **Check this B/L** (on the B/L's page) | "All 6 steps carry the platform's signature, checked in your browser."; each step listed with *Signature checked*; the key fingerprint; "Proof on the blockchain: The platform reports: confirmed on the blockchain on …" |
| 9.2 | **Download the proof** | A file `title-proof-….json`; under **How to verify it offline**, the command with the wallet and the key fingerprint, and **Download the verifier** |
| 9.3 | Optional, on a laptop with Node.js: run that command next to the two downloaded files | The verifier says the proof is valid: every step's signature, and the blockchain record, checked without the platform |

*Say:* "The bank does not have to trust us. Its own browser checked every signature, and the file it just downloaded
can be checked by anyone, years from now, against the public blockchain. If the check says 'pending', the last step is
not on the blockchain yet: it is a matter of minutes."

*Also possible:* on any party's home, **Check a B/L by number** finds the B/L for a company that is party to it, and
says "not found" for one that is not, without saying whether it exists.

## After the demo

The B/L stays accomplished in every party's list. For the next demo, start again from a fresh install (README.md,
"A shipping install"): it removes the B/L and the authenticator set-ups.

# Part 2 · R2: when a B/L does not go as planned (CB-40, CB-67)

The second demo, on an install of R2 or later: the exceptions. Two B/Ls are used, both drafted and issued as in Acts 2
and 3 above, with the ports picked from the port list (Act 10). Each act is short; together about 40 minutes. The cast
is the same seven demo users; no other data is needed.

| B/L | Number (example) | Used for |
|---|---|---|
| The main B/L | `BWML2611011` | the port list, blank endorsement, transfer, amendment, split, the full chain of title, switch to paper |
| The second B/L | `BWML2611012` | the void, and a refusal on a stale page |

*Say, at the start:* "In real trade, B/Ls change hands in blank, ports change, cargo is sold in parts, paper is
asked for, and mistakes are cancelled. Every one of these is a step on the chain, signed and on the blockchain, and
nobody can do one out of turn."

## Act 10 · The carrier's clerk: ports from the list (5 min)

Sign in as **`l.okafor@bluewater-lines.example`**. **New B/L**, filled in as in Act 2, with number `BWML2611011`.

| # | Do | They see |
|---|---|---|
| 10.1 | In **Port of loading**, type `santos` | The list offers `BRSSZ`, Santos, Brazil; pick it. Under the field: "Santos, Brazil" |
| 10.2 | In **Port of discharge**, type `ZZZZZ`, then **Save draft** | The draft is refused: "ZZZZZ is not a sea port of the UN/LOCODE list: pick the port of discharge from the list" |
| 10.3 | Type `rotter`, pick `NLRTM`, **Save draft**, **Submit for approval** | The draft is saved and in review |

Then **`r.menon@bluewater-lines.example`** approves it and **Issue to the shipper** (Act 3). Do the same for the
second B/L, `BWML2611012` (drafted by Lena, issued by Ravi): it stays with the shipper for Act 15.

*Say:* "Ports come from the official UN list of sea ports, so a typing mistake cannot reach a B/L."

## Act 11 · The shipper: endorse in blank (3 min)

Sign in as **`a.ribeiro@highland-coffee.example`**. Open `BWML2611011`.

| # | Do | They see |
|---|---|---|
| 11.1 | **Endorse to…**, pick **Harbour Trust Bank**, choose **In blank** | Under the choice, what endorsing in blank means |
| 11.2 | **Endorse** | "Endorse B/L BWML2611011 (BWML) in blank and hand it to Harbour Trust Bank?", with the same explanation |
| 11.3 | **Endorse in blank** | **Endorsement** "Endorsed in blank"; the chain's row "Endorsed in blank"; her role *Past holder* |

## Act 12 · The exporter's bank: transfer (2 min)

Sign in as **`g.mensah@harbour-trust.example`**. Open `BWML2611011`.

| # | Do | They see |
|---|---|---|
| 12.1 | **Transfer to…**, pick **Northgate Commercial Bank**, **Transfer**, **Transfer** in the confirmation | **Holder** Northgate Commercial Bank; the chain's row "Transferred" |

*Say:* "A blank-endorsed B/L moves by transfer, without a new endorsement. Still one holder, still on the chain."

## Act 13 · The buyer's bank and the carrier: a new port of discharge (5 min)

Sign in as **`m.tanaka@northgate-bank.example`**. Open `BWML2611011`.

| # | Do | They see |
|---|---|---|
| 13.1 | **Ask for a change**, **Send to the carrier** | State *Change requested*; **Holder** "Bluewater Meridian Lines, to go back to Northgate Commercial Bank (your organisation)"; her role "Asked for a change: the B/L comes back to you" |

Sign in as **`r.menon@bluewater-lines.example`**. Open `BWML2611011`.

| # | Do | They see |
|---|---|---|
| 13.2 | **Amend**; in **Port of discharge** type `hamburg`, pick `DEHAM` | Under **Changes**: NLRTM struck through, DEHAM highlighted |
| 13.3 | **Amend and give back**, **Amend** in the confirmation | "B/L amended: version 2 is with Northgate Commercial Bank"; **Version** "Version 2 since …" |

Sign in as **`a.ribeiro@highland-coffee.example`** (an earlier holder). Open `BWML2611011`.

| # | Do | They see |
|---|---|---|
| 13.4 | Read the page | "Amended after you held it", and not the new port |

*Say:* "The buyer's bank asked, the carrier changed it, the holder got it back. The shipper sees that it changed,
not how: that is the holder's business now."

## Act 14 · The buyer's bank and the carrier: split into two B/Ls (5 min)

As **`m.tanaka@northgate-bank.example`**: **Ask for a change**, **Send to the carrier** (as 13.1).

Sign in as **`r.menon@bluewater-lines.example`**. Open `BWML2611011`.

| # | Do | They see |
|---|---|---|
| 14.1 | **Split** | Two new B/Ls, A and B, numbered `BWML2611011-A` and `-B`; A holds all the cargo, B none; the totals show what is still to share |
| 14.2 | Give B/L A 160 packages and 9600 kg, B/L B 160 packages and 9600 kg | The totals add up to the B/L's 320 packages and 19200 kg |
| 14.3 | **Split into 2 B/Ls**, **Split** in the confirmation | State *Split*; no buttons; **Replaced by** `BWML2611011-A` and `BWML2611011-B` |

*Say:* "The buyer sold half the coffee on. Each half now has its own B/L and its own holder, and both trace back to
the original."

## Act 15 · The carrier: void a B/L (2 min)

Before this act, in a **private window**, sign in as **`a.ribeiro@highland-coffee.example`** and open
`BWML2611012`; leave it open.

In the normal window, as **`r.menon@bluewater-lines.example`**, open `BWML2611012`.

| # | Do | They see |
|---|---|---|
| 15.1 | **Void**, **Void the B/L** in the confirmation | "cancelled for good"; State *Void*; no buttons; the chain's row "Voided" |
| 15.2 | In the private window (the shipper's page, not reloaded): **Endorse to…**, pick a bank, **Endorse**, confirm | The refusal in plain words: nothing more can be done with this B/L; the page now shows it as void. Nothing changed |

*Say:* "The shipper's screen was out of date. The platform refused, said why in plain words, and changed nothing."

## Act 16 · The buyer's bank: switch to paper (2 min)

Sign in as **`m.tanaka@northgate-bank.example`**. Open `BWML2611011-B`.

| # | Do | They see |
|---|---|---|
| 16.1 | **Switch to paper**, confirm | "the paper B/L takes over"; State *Switched to paper*; no buttons; the chain's row "Switched to paper" |

## Act 17 · The buyer's bank: the full chain of title (5 min)

Wait until the anchoring batch after Act 16 is out (up to 5 minutes). As **`m.tanaka@northgate-bank.example`**,
open `BWML2611011-A`.

| # | Do | They see |
|---|---|---|
| 17.1 | **Full history and checks** | "Chain of title: B/L BWML2611011-A (BWML)"; "All … steps carry the platform's signature, checked in your browser." |
| 17.2 | Read the table | First the original B/L's steps (issued, endorsed in blank, transferred, the change request, amended, split), then this B/L's; the exceptions marked **Exception**; each signature checked; the latest step on the blockchain, every earlier one linked to it |
| 17.3 | **Download the proof** | The proof file, to check offline as in Act 9 |

*Say:* "An auditor or a court sees the whole life of these goods, across the split, and checks every step without
asking us."

## After the R2 demo

The B/Ls stay in every party's list in their final states. For the next demo, start from a fresh install.

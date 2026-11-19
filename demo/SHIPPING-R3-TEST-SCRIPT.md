# Shipping R3 Demo — Manual Test Script (`CB-76`)

Step-by-step verification script covering **all shipping features (R1 + R2 + R3)** on `lrfe-shipping` (`http://localhost:8089`).

- **Tester:** \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_
- **Date:** \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_
- **Release version (`LRFE_VERSION`):** \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_
- **Overall result:** `[ ] PASS`  `[ ] FAIL`

---

## Pre-checks

| # | Step | Expected result | Pass / Fail |
|---|---|---|---|
| P.1 | Run `node demo/check-readiness.mjs --env deploy/.env.shipping --project lrfe-shipping` | Exits `0` (all containers healthy, shipping pack active, title signer ready, wallet funded) | |
| P.2 | Verify land demo (`http://localhost:8088`), `lrfe-openbao-1`, `lrfe-cardano-1`, and `lrfe-shipping-openbao-1` | All running and untouched | |
| P.3 | Open `http://localhost:8089` in a fresh browser window | Shipping sign-in screen renders cleanly | |

---

## Part 1 · R1 Good-Weather Journey & Default SMDG Carrier Code

| # | Step | Expected result | Pass / Fail |
|---|---|---|---|
| 1.1 | Sign in as `a.morgan@shipping.example` (enrol TOTP on first sign-in) | Lands on **Organisations** showing `BWML`, `HCEX`, `HTB`, `NGCB`, `RCI`, and `Shipping Registry` | |
| 1.2 | Open `Bluewater Meridian Lines` → **Carrier settings**, search `mediterranean`, pick `MSC — Mediterranean Shipping Company`, click **Save carrier code** | `SMDG MSC` badge appears on Bluewater Meridian Lines | |
| 1.3 | Sign out; sign in as `l.okafor@bluewater-lines.example`, click **New B/L** | **Carrier code** dropdown opens pre-selected to `MSC — Mediterranean Shipping Company`; free text cannot be typed; `Shipping Registry` is not in **Shipper** | |
| 1.4 | Fill `BWML2611001`, ports `BRSSZ` → `NLRTM`, cargo `320` bags / `19200` kg, click **Save draft**, then **Submit for approval** | State `In review`; Approval note says a second person must approve; no **Approve** button | |
| 1.5 | Sign in as `r.menon@bluewater-lines.example`, open `BWML2611001`, click **Approve**, then **Issue to the shipper** | State `Issued`, Holder `Highland Coffee Exporters`, 1 chain row `Issued` | |
| 1.6 | Endorse `BWML2611001`: `a.ribeiro` → `Harbour Trust Bank` → `g.mensah` → `Northgate Commercial Bank` → `m.tanaka` → `Roastery Collective Imports` | Holder updates one party at a time; previous holders become `Past holder` with no action buttons | |
| 1.7 | As `y.demir@roastery-collective.example`: **Surrender to the carrier**; as `r.menon`: **Release the goods** | State `Accomplished`, Holder `—`, 6 chain rows | |
| 1.8 | After anchoring (≤ 5 min), sign in as `m.tanaka@northgate-bank.example`, open `BWML2611001`, run **Check this B/L**, download proof & verifier, verify offline | Browser check says all 6 steps signed and latest on blockchain; offline verifier prints valid | |

---

## Part 2 · R2 Exceptions & Drafting Productivity

| # | Step | Expected result | Pass / Fail |
|---|---|---|---|
| 2.1 | As `l.okafor`, open **New B/L**, type `santos` in Port of loading (`BRSSZ`), type `ZZZZZ` in Port of discharge and save | Refused with `ZZZZZ is not a sea port of the UN/LOCODE list`; after picking `NLRTM`, saves `BWML2611011 (MSC)` and `BWML2611012 (MSC)` (both approved & issued by `r.menon`) | |
| 2.2 | As `a.ribeiro`, open `BWML2611011`, **Endorse to…** `Harbour Trust Bank` **In blank**; as `g.mensah`, **Transfer to…** `Northgate Commercial Bank` | Endorsement reads `Endorsed in blank`; transfer moves holder without new endorsement | |
| 2.3 | As `m.tanaka`, **Ask for a change**; as `r.menon`, **Amend** port of discharge to `DEHAM` | Version 2 committed; B/L returns to `Northgate Commercial Bank`; past holder `a.ribeiro` sees notice only | |
| 2.4 | As `m.tanaka`, **Ask for a change**; as `r.menon`, **Split**: test changing split count (`3` → `Remove last B/L` back to `2`), allocate 160 / 9600 each to `BWML2611011-A` and `-B`, confirm split | Parent state `Split` with `Replaced by` links; children `With holder` `Northgate Commercial Bank` with `Split from` link | |
| 2.5 | With `a.ribeiro` viewing `BWML2611012` in a second window, `r.menon` clicks **Void**; `a.ribeiro` clicks **Endorse** on stale page | Void succeeds; stale page refuses cleanly with plain-English message and reloads as `Void` | |
| 2.6 | As `m.tanaka`, **Switch to paper** on `BWML2611011-B` (confirm bearer warning); open **Full history and checks** on `BWML2611011-A` | `BWML2611011-B` is `Switched to paper`; `BWML2611011-A` shows parent + child history with `Exception` tags | |
| 2.7 | As `l.okafor`, open accomplished `BWML2611001`, click **Copy**, verify highlighted blanks, save `BWML2611021`, **Edit** goods, and **Archive** a throwaway draft `BWML2611099` | Copy leaves only B/L number, booking, container, and seal blank & marked; Edit locks B/L number & carrier code; Archive removes `BWML2611099` from list and frees number | |

---

## Part 3 · R3 Network Features (`CB-41`)

| # | Step | Expected result | Pass / Fail |
|---|---|---|---|
| 3.1 | **CB-56 API keys:** As `a.morgan`, create key `Carrier TMS` with `Allow direct B/L issue` on Bluewater | `lrfe_…` secret shown once; list displays prefix & active status | |
| 3.2 | Exchange key via `POST /api/auth/api-token`, then call `POST /api/records/issuance` (`issue: true`, `BWML2611031`, `MSC`, container `BWMU7045331`, seal `SL220931`) | `201 Created`; B/L appears in portal as `Issued` held by `Highland Coffee Exporters` | |
| 3.3 | Call `POST /api/records/issuance` for `BWML2611032` with the same `BWMU7045331` / `SL220931` | Refused with `409` (`duplicate-cargo`) | |
| 3.4 | Revoke `Carrier TMS` key on Bluewater's admin page and retry `POST /api/auth/api-token` | Token exchange immediately returns `401` | |
| 3.5 | **CB-57 Paper reading:** As `l.okafor` on **New B/L**, upload a scan under **Read from paper B/L** and click **Read paper B/L** | Fields populate without auto-saving; uncertain fields show amber highlight + `Check value`; editing clears highlight; **Save draft** creates draft | |
| 3.6 | **CB-55 PINT transfer:** As `a.morgan`, add peer under **Organisations → Connected eBL platforms** (`Base URL`, `Public keys (JWKS JSON)`); as holder on `BWML2611051`, click **Endorse to…** → **A party on another platform**, enter party code, **Check receiver**, **Send to platform** | Moves to **Sending** (**Transferred out** on peer receipt); inbound envelope via `POST /api/records/pint/transfers` lands as **Arrived** and **Keep this B/L** moves it to **With holder** | |

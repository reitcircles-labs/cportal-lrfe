# Demo (epic API-715)

What a demo of the portal needs, next to the install in `deploy/`.

| | |
|---|---|
| `documents/` | The demo document set (API-716): fictitious scans of two chains of title, to scan in, verify, file and build land records from. Its README has the story, the suggested demo flow and what the AI reads. |
| `check-readiness.mjs` | The readiness check (API-717): run it before every demo (below). |

## Before every demo: a known starting state

Decide the starting state before every demo, and make sure the install is in it. Normally that is **a fresh, empty
install**: the demo then shows the whole flow live (scan in, AI reading, verification, filing, land records), and
intake accepts the demo documents. Intake refuses a document it has seen before, so after a rehearsal with the demo
documents the install is no longer in that state.

Continuing with existing data is a deliberate choice, for example to show records built earlier: then skip step 1 and
check in step 2 that the data is the data you expect.

All commands on the server. `deploy/` means `~/projects/cportal-lrfe/deploy`.

### 1. Initialise: a fresh, empty install

In `deploy/`:

```bash
docker compose rm -sf web gateway identity edrms bpm intake land-records audit db-setup nats postgres
docker volume rm lrfe_pgdata lrfe_edrms-files lrfe_intake-files lrfe_natsdata
docker compose up -d --wait
```

The first command stops and removes the portal's containers, the second deletes their data (the database, the filed
and scanned documents, the event stream), the third starts again: the database is set up anew and the 14 demo users are
created again with the demo password of `.env`. OpenBao and the blockchain node, when switched on, keep running
(OpenBao stays unsealed, the node stays synced).

Do not use `docker compose down -v` for this: it also deletes the OpenBao and blockchain volumes (the vault would have
to be initialised again, the node would sync for hours). With an existing database server instead of the bundled one,
its administrator empties the database; then remove only the volumes `lrfe_edrms-files` and `lrfe_intake-files`.

### 2. Readiness check

From the repository root:

```bash
node demo/check-readiness.mjs
```

For a fresh start it must end with **READY** and show, under Data, *0 batches, 0 scanned documents, 0 filed documents,
0 land records*. Any ✗ comes with what to do; fix it and run the check again.

### 3. Prepare the demo users

The check lists each demo user whose authenticator is not set up yet (all of them after step 1). Sign in once as each
user you will show (`http://localhost:8088`, through the SSH tunnel) and set up the authenticator app. A fresh start
removes the earlier set-ups: delete the old entries for the portal in the authenticator app first, or there are two per
user. The demo password: `grep SEED_DEMO_PASSWORD deploy/.env`.

The users of the suggested demo flow (`documents/README.md`):

| Step | User | Role |
|---|---|---|
| Capture | `k.iipinge@deeds.gov.na` | scan operator |
| Verify, file | `a.mwandingi@deeds.gov.na` | reviewer |
| Land record | `j.gawaseb@deeds.gov.na` | records officer |
| Approve | `e.shivute@deeds.gov.na` | supervisor, or another records officer such as `h.haimbodi@deeds.gov.na`: four-eyes, so neither the officer who submitted the record nor the reviewer who filed its documents |
| Optional | `m.nakale@oag.gov.na`, `p.hamutenya@deeds.gov.na` | auditor, administrator |

Only sign in and set up the authenticator; do not upload anything, or the install is no longer empty.

### 4. Final check, shortly before the demo

```bash
node demo/check-readiness.mjs
```

**READY**, still 0 data, and the users you will show marked "authenticator set up". The remaining "!" lines are
expected: users you will not show, and anchoring when it is off.

## Rehearsing without spoiling the demo install

Rehearse on a second install of its own, on other ports, with its own data. Its settings live outside the repository
(they hold secrets):

```bash
sed -e 's/^LRFE_HTTP_PORT=.*/LRFE_HTTP_PORT=8716/' -e 's#^LRFE_PUBLIC_URL=.*#LRFE_PUBLIC_URL=http://localhost:8716#' \
    -e 's/^LRFE_DOCS_PORT=.*/LRFE_DOCS_PORT=3716/' -e 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=postgres,docs/' \
    deploy/.env > ~/lrfe-rehearsal.env
chmod 600 ~/lrfe-rehearsal.env
cd deploy && docker compose -p lrfe-rehearsal --env-file ~/lrfe-rehearsal.env up -d --wait
```

It runs only the portal, its database and the API docs (never an OpenBao or a blockchain node of its own, whatever the
demo install has switched on). It is reached on port 8716 (`./remoteConnect.sh 8716` on the laptop) and checked with
`node demo/check-readiness.mjs --env ~/lrfe-rehearsal.env --project lrfe-rehearsal`. The fresh start of step 1 works
for it the same way with `-p lrfe-rehearsal --env-file ~/lrfe-rehearsal.env` and the volumes named `lrfe-rehearsal_…`.
Remove it when no longer needed: `docker compose -p lrfe-rehearsal --env-file ~/lrfe-rehearsal.env down -v` (in
`deploy/`; it has no OpenBao or blockchain node of its own), then `rm ~/lrfe-rehearsal.env`.

## What the readiness check checks

It reads `deploy/.env` (never printing a secret) and checks:

| Group | What |
|---|---|
| Containers | every container running and healthy, `db-setup` finished, the optional ones of `COMPOSE_PROFILES` (e.g. `docs`) |
| Apps | the web app and its site settings; each service answering through the web app and the gateway; the API docs when the profile is on |
| Demo users | each demo user exists, is active (or suspended/invited as the demo data has them), and the demo password works; whether the authenticator is set up. Checked inside the identity container: nobody is signed in, so no failed sign-in is recorded |
| Reading scans | the AI is set up and accepts its key (checked from the intake container, without spending); the cross-check on or off |
| Demo documents | the set is complete and unchanged (`documents/SHA256SUMS`) |
| Data | what is already in the install (batches, scanned and filed documents, land records), with the fresh-start commands when there is any |
| Anchoring | on or off, and whether the wallet can be read when on |

Each item is ✓ (ready), ! (worth a look) or ✗ (not ready), with what to do. It exits 0 when nothing is ✗, else 1.
`--json` gives the same as JSON; `--env <file> --project <name>` checks another install of the same compose file. It
changes nothing: it does not start or stop containers, sign anyone in or upload anything.

Needs Node.js 20 or later on the server (it is a development server tool, not part of the install bundle).

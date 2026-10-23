# Demo (epic API-715; demo v2, API-774)

What a demo of the portal needs, next to the install in `deploy/`.

| | |
|---|---|
| `documents/` | The demo document set (API-716): fictitious scans of two chains of title, to scan in, verify, file and build land records from. Its README has the story, the suggested demo flow and what the AI reads. |
| `check-readiness.mjs` | The readiness check (API-717): run it before every demo (below). |
| `STORYLINE.md` | The storyline (API-720): what the demo giver does, role by role, from scanning to the audit and the owner's extract that anyone can check. |

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
docker compose rm -sf web gateway identity edrms bpm intake land-records audit extracts db-setup nats postgres
docker volume rm lrfe_pgdata lrfe_edrms-files lrfe_intake-files lrfe_extracts-files lrfe_natsdata
docker compose up -d --wait
```

The first command stops and removes the portal's containers, the second deletes their data (the database, the filed
and scanned documents, the event stream), the third starts again: the database is set up anew and the 14 demo users are
created again with the demo password of `.env`. The extracts register starts again at EX-NA-2026-000001. OpenBao and the blockchain node, when switched on, keep running
(OpenBao stays unsealed, the node stays synced).

**Kept, whatever happens:** `lrfe_cardano-db` (the blockchain node's data: without it the node syncs again for hours)
and `lrfe_bao-data` (OpenBao with the wallet key: without it the wallet and its funds are lost). The demo install
declares them external (`compose.keep-volumes.yml`, switched on by `COMPOSE_FILE` in `deploy/.env`), so compose never
deletes them, not even `docker compose down -v`. Only `docker volume rm` with their names, or `docker volume prune
--all` while the portal is stopped, would. The services' OpenBao logins (`lrfe_bao-audit`, `lrfe_bao-edrms`,
`lrfe_bao-intake`, `lrfe_bao-extracts`) are not locked: `down -v` deletes them, and the setup of "Anchoring for the demo" (step 2, the
last command) makes them again. With an existing database server instead of the bundled one,
its administrator empties the database; then remove only the volumes `lrfe_edrms-files`, `lrfe_intake-files` and
`lrfe_extracts-files`.

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

The users of the storyline ([STORYLINE.md](STORYLINE.md)):

| Step | User | Role |
|---|---|---|
| Capture | `k.iipinge@deeds.gov.na` | scan operator |
| Verify, file | `a.mwandingi@deeds.gov.na` | reviewer |
| Land record | `j.gawaseb@deeds.gov.na` | records officer |
| Approve | `e.shivute@deeds.gov.na` | supervisor, or another records officer such as `h.haimbodi@deeds.gov.na`: four-eyes, so neither the officer who submitted the record nor the reviewer who filed its documents |
| Audit | `m.nakale@oag.gov.na` | auditor |
| Optional | `p.hamutenya@deeds.gov.na` | administrator |

Only sign in and set up the authenticator; do not upload anything, or the install is no longer empty.

### 4. Final check, shortly before the demo

```bash
node demo/check-readiness.mjs
```

**READY**, still 0 data, and the users you will show marked "authenticator set up". Under Anchoring: the wallet
readable, the blockchain node synced, enough funds. The remaining "!" lines are expected: users you will not show.

## Encryption at rest

The demo always stores its files encrypted (API-795): the scans in intake, the filed documents in edrms and the
extract PDFs, each with a data key wrapped by its own key in OpenBao. `deploy/.env` has `EDRMS_ENCRYPTION=bao`,
`INTAKE_ENCRYPTION=bao` and `EXTRACTS_ENCRYPTION=bao` (also the defaults when unset), and the readiness check fails
("Encryption at rest") when a service has it off or a stored file is not encrypted, for example one stored before
encryption was switched on: a fresh install (`node demo/release.mjs`, mode fresh) starts again with encrypted files only.
While OpenBao is sealed (below), the three services wait for it and restart until it is unsealed.

## Anchoring for the demo

The auditor signs off only what is on the blockchain, so the demo install anchors (API-723). It runs the bundled
OpenBao (the wallet key) and blockchain node: `COMPOSE_PROFILES=postgres,docs,bao,blockchain`,
`CARDANO_PROVIDER=ogmios` and `ANCHOR_PERIOD=5m` in `deploy/.env`. Five minutes instead of an hour, so that a record
approved in the demo is on the blockchain before the auditor signs off. A batch goes out only when something new
happened, so an idle install spends nothing.

**After every restart of the server or of OpenBao's container**, OpenBao is sealed and the audit service cannot sign;
the readiness check then says the wallet cannot be read. Unseal it, in `deploy/`:

```bash
python3 -c "import json,os,sys; sys.stdout.write(json.load(open(os.path.expanduser('~/lrfe-demo-openbao-init.json')))['unseal_keys_b64'][0])" \
  | docker compose exec -T openbao bao write -address=http://127.0.0.1:8200 sys/unseal key=-
```

`~/lrfe-demo-openbao-init.json` (outside the repository, readable by this user only) holds the unseal key and the
root token. That is a demo shortcut: a real site splits the unseal key among key holders and keeps none on the
server (`deploy/README.md`, part D).

**Funds:** the readiness check shows the wallet's address and funds. Below `ANCHOR_MIN_BALANCE_ADA` (5), send test
ADA (preview) to that address; each batch costs about 0.2 ADA.

**How it was set up** (once; to do it again, for example on another server), in `deploy/`:

1. **The node's data**, copied from a synced preview node of the same version (cardano-node 11.0.1), instead of the
   first sync of about 11 hours. `docker compose --profile blockchain create cardano`, then copy the other node's `db`
   folder into the volume, without its `lock` file:

   ```bash
   rsync -a --exclude=/lock <other node>/db/ "$(docker volume inspect lrfe_cardano-db --format '{{.Mountpoint}}')/"
   ```

   With rootless Docker (as here) the folder belongs to you; with Docker run as root, prefix `sudo`. The other node
   keeps running; it is only read. Because its data is copied while it runs, the bundled node checks the whole copy
   on its first start (it logs "Validating chunk … Progress"), then catches up: on this server the copy took about
   45 minutes and the check about 1.5 hours, against 11 hours for a first sync. Later starts are quick.
2. **OpenBao**: `docker compose --profile bao up -d openbao`, then initialise it with a single key, written into the
   file (nothing is shown). Only once, on a new OpenBao: the command refuses to overwrite an existing file, which
   holds the only unseal key.

   ```bash
   (set -o noclobber; umask 077; docker compose exec -T openbao bao operator init -address=http://127.0.0.1:8200 \
     -key-shares=1 -key-threshold=1 -format=json > ~/lrfe-demo-openbao-init.json)
   ```

   If it failed (for example OpenBao was not up yet), it leaves an empty file that blocks the next try: remove it
   only if it is empty, `test -s ~/lrfe-demo-openbao-init.json || rm ~/lrfe-demo-openbao-init.json`, and run it again.

   Unseal it (above), then prepare it; this creates a new wallet key (`audit-anchor`):

   ```bash
   BAO_TOKEN=$(python3 -c "import json,os,sys; sys.stdout.write(json.load(open(os.path.expanduser('~/lrfe-demo-openbao-init.json')))['root_token'])") \
     docker compose --profile bao-setup run --rm -T -e BAO_TOKEN openbao-setup
   ```
3. **The settings** above in `.env`, then `docker compose up -d --wait`, and fund the wallet.

4. **The lock and a backup:** `COMPOSE_FILE=docker-compose.yml:../demo/compose.keep-volumes.yml` in `.env` (see "Kept,
   whatever happens" above), and a snapshot of OpenBao in `~/lrfe-backups/` (this user only), made again whenever
   the setup is run again:

   ```bash
   F=~/lrfe-backups/openbao-snapshot-$(date +%Y%m%d-%H%M).snap
   (umask 077; BAO_TOKEN=$(python3 -c "import json,os,sys; sys.stdout.write(json.load(open(os.path.expanduser('~/lrfe-demo-openbao-init.json')))['root_token'])") \
     docker compose exec -T -e BAO_TOKEN openbao sh -c 'bao operator raft snapshot save -address=http://127.0.0.1:8200 /tmp/s.snap && cat /tmp/s.snap && rm /tmp/s.snap' \
     > "$F.part") && test -s "$F.part" && mv "$F.part" "$F" && ls -l "$F"
   ```

   The snapshot is encrypted: it is of use only with the unseal key of `~/lrfe-demo-openbao-init.json`, so keep a copy
   of both off the server. Restoring it (not tried on this install): into a running, initialised and unsealed OpenBao,
   with a root token of that OpenBao in `BAO_TOKEN`:

   ```bash
   docker compose cp ~/lrfe-backups/<snapshot>.snap openbao:/tmp/s.snap
   docker compose exec -T -e BAO_TOKEN openbao bao operator raft snapshot restore -force -address=http://127.0.0.1:8200 /tmp/s.snap
   ```

   It then has the snapshot's keys: unseal it with the unseal key that belongs to the snapshot.

The fresh start (step 1 of "Before every demo") keeps OpenBao, its wallet key and the node: only the portal's data
goes. Each fresh install numbers its batches from 1 again; the wallet's earlier transactions stay on the blockchain.

## A new demo version from main

`demo/release.mjs` (API-794) makes a new demo version from `origin/main`, the same way every time, with
the guards of the steps above. In Claude Code, ask for it ("a new demo version from main"): the
`demo-release` agent (`.claude/agents/demo-release.md`) runs it, after you have said whether to keep
the demo's data. By hand, from the repository root:

```bash
node demo/release.mjs build                                 # the images of origin/main, e.g. 0.1.0-3b19fe7
node demo/release.mjs rehearse --version 0.1.0-3b19fe7      # a throwaway install with its own OpenBao: READY?
node demo/release.mjs test --version 0.1.0-3b19fe7          # the docker e2e on the images
node demo/release.mjs deploy --version 0.1.0-3b19fe7 --mode upgrade   # or --mode fresh: data erased
```

or all four, stopping at the first failure: `node demo/release.mjs all --mode upgrade`.

- **upgrade** keeps the data and the authenticator set-ups; **fresh** is step 1 of "Before every demo"
  (and the users set up their authenticators again).
- The deploy refuses, before changing anything, if the blockchain node's or OpenBao's configuration
  would change; afterwards it checks they are the same containers, never restarted, and that
  `lrfe_cardano-db` and `lrfe_bao-data` are there. It copies `deploy/.env` to
  `~/lrfe-env.backup-<date>` and changes only `LRFE_VERSION`.
- **Going back:** the older images are kept: `node demo/release.mjs deploy --version <previous> --mode upgrade`.

## Ownership extracts for the demo

Act 6 of the storyline issues an ownership extract (epic API-689) and checks it on the public check page. It needs
images built from main after 22 October 2026, and the registry's **electronic seal**: in production, without it,
issuing an extract is refused. The seal's key lives in OpenBao, like the wallet key, and is never exported.

1. **The keys and logins** for the extracts service (`extracts-seal`, `extracts-files`): run the setup of "Anchoring
   for the demo" (step 2, the last command) again. It keeps what works, the wallet key included, and never touches
   `lrfe_bao-data`'s other keys. Then make a new OpenBao snapshot (step 4).
2. **A certificate for the seal key.** A registry gets it from its certificate authority (`deploy/README.md`, part
   D, step 6). For the demo, a certificate from a demo authority made on the server is enough; it says "not valid" in
   its names. In a folder of this user only, with the root token as in step 2:

   ```bash
   mkdir -p ~/lrfe-demo-seal && cd ~/lrfe-demo-seal && umask 077
   # the seal key's public key, from OpenBao (the latest version); -f because this runs outside deploy/
   BAO_TOKEN=$(python3 -c "import json,os,sys; sys.stdout.write(json.load(open(os.path.expanduser('~/lrfe-demo-openbao-init.json')))['root_token'])") \
     docker compose -f ~/projects/cportal-lrfe/deploy/docker-compose.yml exec -T -e BAO_TOKEN openbao \
     bao read -address=http://127.0.0.1:8200 -format=json transit/keys/extracts-seal \
     | python3 -c "import json,sys; k=json.load(sys.stdin)['data']['keys']; print(k[max(k, key=int)]['public_key'])" \
     > extracts-seal.pub.pem
   # a demo authority, and the seal certificate it issues for that public key
   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout demo-ca.key -out demo-ca.pem \
     -days 365 -subj "/CN=Demo seal authority (not valid)"
   openssl req -new -key demo-ca.key -subj "/O=Deeds Registry/CN=Deeds Registry (demo seal, not valid)" -out seal.csr
   openssl x509 -req -in seal.csr -CA demo-ca.pem -CAkey demo-ca.key -CAcreateserial \
     -force_pubkey extracts-seal.pub.pem -days 365 -out seal.pem
   # one line, with \n for each line break, for .env
   awk 'NF {printf "%s\\n", $0}' seal.pem; echo
   ```

   The certificate is accepted only for that key: the service checks it before it signs anything.
3. **The settings** in `deploy/.env`: `LRFE_SEAL=bao`, `LRFE_SEAL_CERT=` the line printed above,
   `EXTRACTS_ENCRYPTION=bao` (the default: the extract PDFs encrypted like the documents), optionally `LRFE_COAT_OF_ARMS` (a PNG or
   JPEG; its path starts with `./` or `/`), and `LRFE_TIME_ZONE=Africa/Windhoek`: the time printed on the extract
   (unset, it is UTC and differs from the screens). `LRFE_PUBLIC_URL` is the address printed on the extract and held
   by its QR code: for the demo through the SSH tunnel, `http://localhost:8088`. Then `docker compose up -d --wait`.
4. **Check:** as the records officer, a land record whose version is on the blockchain, tab **Extracts**: **Issue
   extract** is enabled once the version is confirmed. Do not issue one on the demo install before the demo: a fresh
   start (step 1 of "Before every demo") resets the register.

## Rehearsing without spoiling the demo install

Rehearse on a second install of its own, on other ports, with its own data. Its settings live outside the repository
(they hold secrets):

```bash
sed -e 's/^LRFE_HTTP_PORT=.*/LRFE_HTTP_PORT=8716/' -e 's#^LRFE_PUBLIC_URL=.*#LRFE_PUBLIC_URL=http://localhost:8716#' \
    -e 's/^LRFE_DOCS_PORT=.*/LRFE_DOCS_PORT=3716/' -e 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=postgres,docs/' \
    -e 's/^CARDANO_PROVIDER=.*/CARDANO_PROVIDER=/' -e '/^COMPOSE_FILE=/d' \
    deploy/.env > ~/lrfe-rehearsal.env
chmod 600 ~/lrfe-rehearsal.env
cd deploy && docker compose -p lrfe-rehearsal --env-file ~/lrfe-rehearsal.env up -d --wait
```

It runs only the portal, its database and the API docs, with anchoring off (never an OpenBao or a blockchain node of
its own, whatever the demo install has switched on). It is reached on port 8716 (`./remoteConnect.sh 8716` on the
laptop) and checked with
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
| Anchoring | on or off; when on: the wallet can be read (its address), the blockchain node is synced, the wallet has at least `ANCHOR_MIN_BALANCE_ADA` |

Each item is ✓ (ready), ! (worth a look) or ✗ (not ready), with what to do. It exits 0 when nothing is ✗, else 1.
`--json` gives the same as JSON; `--env <file> --project <name>` checks another install of the same compose file. It
changes nothing: it does not start or stop containers, sign anyone in or upload anything.

Needs Node.js 20 or later on the server (it is a development server tool, not part of the install bundle).

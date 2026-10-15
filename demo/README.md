# Demo (epic API-715)

What a demo of the portal needs, next to the install in `deploy/`.

| | |
|---|---|
| `documents/` | The demo document set (API-716): fictitious scans of two chains of title, to scan in, verify, file and build land records from. Its README has the story, the suggested demo flow and what the AI reads. |
| `check-readiness.mjs` | The readiness check (API-717): run it before the demo. |

## Before the demo

On the server, from the repository root:

```bash
node demo/check-readiness.mjs
```

It reads `deploy/.env` (never printing a secret) and checks:

| Group | What |
|---|---|
| Containers | every container running and healthy, `db-setup` finished, the optional ones of `COMPOSE_PROFILES` (e.g. `docs`) |
| Apps | the web app and its site settings; each service answering through the web app and the gateway; the API docs when the profile is on |
| Demo users | each demo user exists, is active (or suspended/invited as the demo data has them), and the demo password works; whether the authenticator is set up. Checked inside the identity container: nobody is signed in, so no failed sign-in is recorded |
| Reading scans | the AI is set up (provider, key) and reachable from the intake container, without spending; the cross-check on or off |
| Demo documents | the set is complete and unchanged (`documents/SHA256SUMS`) |
| Data | what is already in the install (batches, scanned and filed documents, land records) |
| Anchoring | on or off, and the wallet when on |

Each item is ✓ (ready), ! (worth a look) or ✗ (not ready), with what to do. It exits 0 when nothing is ✗, else 1.
`--json` gives the same as JSON; `--env <file> --project <name>` checks another install of the same compose file.

Worth doing when it says so:

- **Authenticator not set up yet**: sign in once as each demo user you will show and set up the authenticator app, so
  the demo does not wait for it.
- **Already data in the install**: fine to continue with it. Intake refuses a demo document it has seen before; for a
  fresh start the check prints the commands. With the bundled database they remove only the portal's containers and
  its data volumes (`pgdata`, `edrms-files`, `intake-files`, `natsdata`) and start again; OpenBao and the blockchain
  node keep running (so OpenBao stays unsealed). Not `docker compose down -v`: that also deletes their volumes
  (re-initialising the vault, hours of blockchain sync). With an existing database server, its administrator empties
  the database. Either way the authenticator set-ups are gone too.

Needs Node.js 20 or later on the server (it is a development server tool, not part of the install bundle).

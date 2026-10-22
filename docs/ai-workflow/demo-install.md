# Working on the demo install

The guide is `demo/README.md` (fresh start, readiness, anchoring, ownership extracts, a new version)
and the storyline `demo/STORYLINE.md`. This page holds what must never go wrong.

## What it is

- Compose project **`lrfe`** in `deploy/`, settings in `deploy/.env` (not in git), web on port 8088
  (reached through an SSH tunnel), `COMPOSE_FILE` includes `../demo/compose.keep-volumes.yml`, which
  declares `lrfe_cardano-db` and `lrfe_bao-data` external so compose never deletes them.
- OpenBao holds the wallet key and the seal keys; its init file (unseal key, root token) is
  `~/lrfe-demo-openbao-init.json`, snapshots in `~/lrfe-backups/`. The demo seal certificate and its
  demo authority are in `~/lrfe-demo-seal/`.

## Never

- delete `lrfe_cardano-db` (hours of resync) or `lrfe_bao-data` (the wallet and its funds);
- `docker compose down -v` or `docker volume prune` on `lrfe`;
- stop, restart, recreate or signal the `cardano` or `openbao` containers, or the user's own preview
  node (`~/data/cportal-lrfe/cardano/preview`);
- rehearse the storyline on the demo install without a fresh start afterwards (intake refuses a
  document it has seen; the users' authenticators go with a fresh start: tell the user).

## How

- **A new version:** `node demo/release.mjs` (or the `demo-release` agent). It builds from
  `origin/main`, rehearses, tests, then deploys `--mode upgrade|fresh` with the guards; the mode is
  the user's choice. Going back: deploy the previous version with `--mode upgrade`.
- **Anything else** (a setting, the seal): back up `deploy/.env` first; before `up`, compare
  `docker compose config --hash "openbao,cardano"` with the running containers' config-hash labels;
  after, check the same container IDs, start times and restart counts; then the readiness check
  (`node demo/check-readiness.mjs`).
- **Experiments:** the throwaway project `lrfe-rehearsal` (port 8716, its own OpenBao, removed with
  `node demo/release.mjs teardown`). Never use `--profile` alone on it: it replaces
  `COMPOSE_PROFILES`, so `down` misses the others' containers.
- Set `LRFE_TIME_ZONE` (Africa/Windhoek for Namibia): unset, the extract prints UTC.

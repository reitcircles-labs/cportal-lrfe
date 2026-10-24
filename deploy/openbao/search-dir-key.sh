#!/bin/sh
# The key of the search engine's encrypted directory (API-799), for scripts/search_dir.py
# (deploy/docker-compose.yml, service search-dir-key; never run by hand):
#
#   new      a new 512-bit key from OpenBao's key search-dir: prints OpenBao's JSON answer with the
#            key (plaintext) and its wrapped form (ciphertext)
#   unwrap   reads the wrapped key on stdin and prints the key (base64)
#
# Logs in with the AppRole search-dir (written by setup.sh into its own volume). What it prints goes
# to the script's pipe only; nothing is written.
set -eu

dir=/approle/search-dir
if [ ! -s "$dir/secret-id" ]; then
    echo "no login for search-dir: run docker compose run --rm openbao-setup (README.md, part D)" >&2
    exit 1
fi
BAO_TOKEN=$(bao write -field=token auth/approle/login role_id="$(cat "$dir/role-id")" secret_id="$(cat "$dir/secret-id")")
export BAO_TOKEN

case "${1:-}" in
    new) bao write -format=json -f transit/datakey/plaintext/search-dir bits=512 ;;
    unwrap) bao write -field=plaintext transit/decrypt/search-dir ciphertext="$(cat)" ;;
    *) echo "usage: search-dir-key.sh new|unwrap" >&2; exit 2 ;;
esac

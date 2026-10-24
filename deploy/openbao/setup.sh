#!/bin/sh
# Prepares OpenBao for the portal (deploy/docker-compose.yml, service openbao-setup):
#
#   docker compose run --rm openbao-setup
#
# Asks for a token allowed to configure OpenBao (the root token right after initialising), then,
# without changing what already works:
#   - the transit engine and AppRole logins;
#   - one key per service, never exportable: edrms-files and intake-files (stored files),
#     audit-anchor (ed25519, the audit service's blockchain wallet key), extracts-seal (ecdsa-p256,
#     the organisation seal on ownership extracts), extracts-files (its stored PDFs) and search-dir
#     (the search engine's encrypted directory);
#   - a policy per service that allows only what it needs on its own keys;
#   - an AppRole per service (1 h tokens), whose role ID and secret ID go into that service's
#     own volume, readable only by the service (the node user, uid 1000).
# The same steps as backend/scripts/bao.js (in the source repository) for a development machine.
set -eu

# where the services' volumes are mounted (deploy/docker-compose.yml)
APPROLE_DIR=${APPROLE_DIR:-/approle}

if [ -z "${BAO_TOKEN:-}" ]; then
    printf 'OpenBao token (not shown): '
    stty -echo 2>/dev/null || true
    read -r BAO_TOKEN
    stty echo 2>/dev/null || true
    echo
fi
export BAO_TOKEN

if ! bao status >/dev/null 2>&1; then
    echo "OpenBao at $BAO_ADDR is not running, not initialised or sealed: initialise and unseal it first (README.md)." >&2
    exit 1
fi

bao secrets list | grep -q '^transit/' || bao secrets enable transit >/dev/null
bao auth list | grep -q '^approle/' || bao auth enable approle >/dev/null

# a transit key, created once, never exportable: key  key type
transit_key() {
    bao read "transit/keys/$1" >/dev/null 2>&1 || bao write -f "transit/keys/$1" type="$2" exportable=false >/dev/null
}

# service  key  key type  policy lines (its policy is named after the key)
prepare() {
    service=$1 key=$2 type=$3 policy=$4
    transit_key "$key" "$type"
    printf '# %s: only what it needs, on its own keys only (written by setup.sh)\n%s\n' "$service" "$policy" | bao policy write "$key" - >/dev/null
    bao write "auth/approle/role/$service" token_policies="$key" token_ttl=1h token_max_ttl=24h >/dev/null

    dir="$APPROLE_DIR/$service"
    bao read -field=role_id "auth/approle/role/$service/role-id" > "$dir/role-id.new"
    mv -f "$dir/role-id.new" "$dir/role-id"
    # keep a secret ID that still logs in; otherwise issue a new one
    if [ -s "$dir/secret-id" ] && BAO_TOKEN= bao write auth/approle/login role_id="$(cat "$dir/role-id")" secret_id="$(cat "$dir/secret-id")" >/dev/null 2>&1; then
        :
    else
        (umask 077; bao write -f -field=secret_id "auth/approle/role/$service/secret-id" > "$dir/secret-id.new")
        mv -f "$dir/secret-id.new" "$dir/secret-id"
    fi
    # the services run as the node user (uid 1000); setup runs as root in its container
    if [ "$(id -u)" = 0 ]; then chown 1000:1000 "$dir/role-id" "$dir/secret-id"; fi
    chmod 400 "$dir/role-id" "$dir/secret-id"
    echo "  $service: key $key, login ready"
}

prepare edrms edrms-files aes256-gcm96 'path "transit/datakey/plaintext/edrms-files" { capabilities = ["update"] }
path "transit/decrypt/edrms-files" { capabilities = ["update"] }'
prepare intake intake-files aes256-gcm96 'path "transit/datakey/plaintext/intake-files" { capabilities = ["update"] }
path "transit/decrypt/intake-files" { capabilities = ["update"] }'
prepare audit audit-anchor ed25519 'path "transit/sign/audit-anchor" { capabilities = ["update"] }
path "transit/keys/audit-anchor" { capabilities = ["read"] }'
# the extracts service: its seal, and the key for its stored PDFs (API-780)
transit_key extracts-files aes256-gcm96
prepare extracts extracts-seal ecdsa-p256 'path "transit/sign/extracts-seal" { capabilities = ["update"] }
path "transit/keys/extracts-seal" { capabilities = ["read"] }
path "transit/datakey/plaintext/extracts-files" { capabilities = ["update"] }
path "transit/decrypt/extracts-files" { capabilities = ["update"] }'
# the search engine's encrypted directory (API-799): scripts/search_dir.py, through the
# one-shot service search-dir-key
prepare search-dir search-dir aes256-gcm96 'path "transit/datakey/plaintext/search-dir" { capabilities = ["update"] }
path "transit/decrypt/search-dir" { capabilities = ["update"] }'

echo "OpenBao is ready for the portal. Set EDRMS_ENCRYPTION=bao, INTAKE_ENCRYPTION=bao and EXTRACTS_ENCRYPTION=bao in .env (and, once the seal certificate is in LRFE_SEAL_CERT, LRFE_SEAL=bao), then: docker compose up -d"

#!/bin/bash
# Prepares the search engine before every start (deploy/docker-compose.yml, service search-prepare;
# README.md, part I). Runs as root in the search engine's own image, after the guard
# search-dir-check, so the directory below is the encrypted, unlocked one. Changes nothing that
# works:
#   - the directory: the engine's data, log and heap dumps, each its own subfolder, owned by the
#     engine's user (uid 1000) and readable by the install user's group (for its size);
#   - the configuration (volume search-config): the image's own, then ours (opensearch.yml, the
#     users, their roles, the certificates, made once);
#   - one login per service that may use it (search: writes, edrms: reads), made once, each in
#     that service's own volume with the certificate authority, readable only by the service (the
#     node user, uid 1000).
set -euo pipefail

DATA=/lrfe-search
CONFIG=/config
OURS=/lrfe
HOME_DIR=/usr/share/opensearch
KEYTOOL=$HOME_DIR/jdk/bin/keytool

fail() {
    echo "search-prepare: $*" >&2
    exit 1
}

# A random password of $1 letters and digits (a whole read, then cut: no broken pipe)
random() {
    local chars
    chars=$(head -c 1024 /dev/urandom | tr -dc 'A-Za-z0-9')
    printf '%s' "${chars:0:$1}"
}

[ -f "$DATA/.lrfe-encrypted" ] || fail "the search engine's directory is not unlocked (python3 scripts/search_dir.py status)"

# ---- the directory ----
# The top stays the install user's: the engine only passes through it to its own subfolders. Their
# group is the top's (the install user's), kept by what the engine creates in them (setgid).
group=$(stat -c %g "$DATA")
for sub in data logs dumps; do
    mkdir -p "$DATA/$sub"
    chown 1000:"$group" "$DATA/$sub"
    chmod 2750 "$DATA/$sub"
done
chmod 0711 "$DATA"

# ---- the configuration: the image's own (fresh from this version), then ours ----
cp -a "$HOME_DIR/config/." "$CONFIG/"
cp "$OURS/config.yml" "$OURS/roles.yml" "$OURS/roles_mapping.yml" "$CONFIG/opensearch-security/"
cp "$OURS/log4j2.properties" "$CONFIG/"

# ---- the certificates, made once (TLS between the services and the engine) ----
# A certificate authority of this install only; the engine's certificate (also its node identity)
# and the administrator's certificate, which applies the users and roles (service search-users).
# To renew them: remove the folder certs from the volume search-config and start again.
certs=$CONFIG/certs
mkdir -p "$certs"
chmod 700 "$certs"
if [ ! -s "$certs/admin.p12" ]; then
    rm -f "$certs"/*
    (umask 077; random 32 > "$certs/password")
    pass=$(cat "$certs/password")
    kt() {
        "$KEYTOOL" "$@" -storetype PKCS12 -storepass "$pass" 2>/dev/null || fail "keytool $1 failed (the certificates)"
    }
    kt -genkeypair -keystore "$certs/ca.p12" -alias ca -keyalg EC -groupname secp256r1 \
        -dname CN=lrfe-search-ca -ext bc:c -validity 3650
    kt -exportcert -keystore "$certs/ca.p12" -alias ca -rfc -file "$certs/ca.pem"
    kt -importcert -keystore "$certs/truststore.p12" -alias ca -file "$certs/ca.pem" -noprompt
    # name  common name  extensions
    signed() {
        kt -genkeypair -keystore "$certs/$1.p12" -alias "$1" -keyalg EC -groupname secp256r1 \
            -dname "CN=$2" -validity 3650
        kt -certreq -keystore "$certs/$1.p12" -alias "$1" -file "$certs/$1.csr"
        kt -gencert -keystore "$certs/ca.p12" -alias ca -infile "$certs/$1.csr" -outfile "$certs/$1.pem" \
            -rfc -validity 3650 -ext KU=digitalSignature -ext EKU=serverAuth,clientAuth "${@:3}"
        kt -importcert -keystore "$certs/$1.p12" -alias ca -file "$certs/ca.pem" -noprompt
        kt -importcert -keystore "$certs/$1.p12" -alias "$1" -file "$certs/$1.pem"
        rm -f "$certs/$1.csr"
    }
    signed node opensearch -ext SAN=dns:opensearch,dns:localhost
    signed admin lrfe-search-admin
    echo "  certificates made"
fi
pass=$(cat "$certs/password")

# ---- one login per service, made once ----
# service  user
login() {
    local dir=/login/$1
    if [ ! -s "$dir/password" ]; then
        (umask 077; random 40 > "$dir/password.new")
        mv -f "$dir/password.new" "$dir/password"
        echo "  $1: login made"
    fi
    printf '%s' "$2" > "$dir/user"
    cp "$certs/ca.pem" "$dir/ca.pem"
    chown 1000:1000 "$dir/user" "$dir/password" "$dir/ca.pem"
    chmod 400 "$dir/user" "$dir/password" "$dir/ca.pem"
}
login search lrfe-search
login edrms lrfe-edrms

# The users with their password hashes (the passwords themselves stay in the logins)
# (the tool also looks up the container's name, which has no network: that error is left out)
hash() {
    local hashed
    hashed=$(LRFE_PASSWORD=$(cat "/login/$1/password") \
        "$HOME_DIR/plugins/opensearch-security/tools/hash.sh" -env LRFE_PASSWORD 2>/dev/null | tail -n 1)
    [[ $hashed == '$2'* ]] || fail "the password of $1 could not be hashed"
    printf '%s' "$hashed"
}
search_hash=$(hash search)
edrms_hash=$(hash edrms)
cat > "$CONFIG/opensearch-security/internal_users.yml" <<EOF
# Written by search-prepare on every start (deploy/opensearch/prepare.sh): one user per service
_meta:
  type: "internalusers"
  config_version: 2
lrfe-search:
  hash: "$search_hash"
  description: "The search service: writes the documents' index"
lrfe-edrms:
  hash: "$edrms_hash"
  description: "edrms: reads the documents' index"
EOF

# ---- opensearch.yml ----
# Disk watermarks as free space, from OPENSEARCH_MIN_FREE_GB (in bytes, as the readiness check
# counts a GB): below it no new shard is placed, below half of it shards move away (there is no
# other node), below a quarter the indexes take no more writes, until there is space again.
min_free=$(( ${OPENSEARCH_MIN_FREE_GB:-100} * 1000000000 ))
cat > "$CONFIG/opensearch.yml" <<EOF
# Written by search-prepare on every start (deploy/opensearch/prepare.sh)
cluster.name: lrfe-search
node.name: opensearch
network.host: 0.0.0.0
discovery.type: single-node
path.data: $DATA/data
path.logs: $DATA/logs

cluster.routing.allocation.disk.watermark.enable_for_single_data_node: true
cluster.routing.allocation.disk.watermark.low: $(( min_free ))b
cluster.routing.allocation.disk.watermark.high: $(( min_free / 2 ))b
cluster.routing.allocation.disk.watermark.flood_stage: $(( min_free / 4 ))b

plugins.security.ssl.transport.keystore_type: PKCS12
plugins.security.ssl.transport.keystore_filepath: certs/node.p12
plugins.security.ssl.transport.keystore_alias: node
plugins.security.ssl.transport.truststore_type: PKCS12
plugins.security.ssl.transport.truststore_filepath: certs/truststore.p12
plugins.security.ssl.transport.enforce_hostname_verification: false
plugins.security.ssl.http.enabled: true
plugins.security.ssl.http.keystore_type: PKCS12
plugins.security.ssl.http.keystore_filepath: certs/node.p12
plugins.security.ssl.http.keystore_alias: node
plugins.security.ssl.http.truststore_type: PKCS12
plugins.security.ssl.http.truststore_filepath: certs/truststore.p12
# a client certificate is asked for but not required: only the administrator's has one
plugins.security.ssl.http.clientauth_mode: OPTIONAL
plugins.security.authcz.admin_dn: ["CN=lrfe-search-admin"]
plugins.security.nodes_dn: ["CN=opensearch"]
# the first start loads the users and roles from the configuration; search-users keeps them current
plugins.security.allow_default_init_securityindex: true
plugins.security.restapi.roles_enabled: []
plugins.security.system_indices.enabled: true
EOF

# The certificate stores' password, in the engine's own keystore (made again on every start)
rm -f "$CONFIG/opensearch.keystore"
OPENSEARCH_PATH_CONF=$CONFIG "$HOME_DIR/bin/opensearch-keystore" create >/dev/null 2>&1 \
    || fail "the engine's keystore could not be made"
secure=()
for layer in transport http; do
    for name in keystore_password keystore_keypassword truststore_password; do
        secure+=("plugins.security.ssl.$layer.${name}_secure")
    done
done
# the same password for each, one per line
for _ in "${secure[@]}"; do echo "$pass"; done | OPENSEARCH_PATH_CONF=$CONFIG \
    "$HOME_DIR/bin/opensearch-keystore" add --stdin "${secure[@]}" >/dev/null 2>&1 \
    || fail "the engine's keystore could not be written"

# ---- the JVM: heap dumps and crash files into the encrypted directory, not the container ----
sed -i "s|file=logs/gc.log|file=$DATA/logs/gc.log|" "$CONFIG/jvm.options"
cat > "$CONFIG/jvm.options.d/lrfe.options" <<EOF
-XX:HeapDumpPath=$DATA/dumps
-XX:ErrorFile=$DATA/logs/hs_err_pid%p.log
EOF

chown -R 1000:1000 "$CONFIG"
chmod -R go= "$CONFIG"
echo "search-prepare: ready"
